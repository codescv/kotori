/**
 * Local Yomitan v3 dictionaries over `node:sqlite` (spec:
 * kotori_dictionary_design_proposal §4).
 *
 * Import is fully streaming: the ZIP bytes are fed chunk-by-chunk into fflate's
 * `Unzip`, every `term_bank_*.json` / `term_meta_bank_*.json` entry is split
 * into rows by `JsonArrayRowSplitter` as it inflates, and rows are written in
 * 2,500-row transactions — the archive, a whole bank, or the full row set is
 * never held in memory. Imports are blue-green: rows land under a fresh
 * `dictId` with `status = 'importing'` (invisible to lookups, purged on
 * startup) and one final transaction flips it to `ready` and drops any
 * previous dictionary with the same title (inheriting its priority/enabled).
 */
import { randomBytes } from 'node:crypto';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import {
  JsonArrayRowSplitter,
  KotoriError,
  MetaRowAccumulator,
  enrichVocabBatch,
  inferDictionaryKind,
  isUsableDictionary,
  lookupPrefixBatch,
  normalizeZipEntryPath,
  parseYomitanIndex,
  parseYomitanMetaRow,
  parseYomitanTermRow,
  termLookupKeys,
  type CompactSense,
  type CompactTermRecord,
  type DictMetaRecord,
  type DictionaryInfo,
  type DictionaryKind,
  type DictionaryLookupSource,
  type InstantLookupMatch,
  type VocabEnrichment,
  type VocabEntry,
  type YomitanEntryKind,
  type YomitanIndex,
} from '@kotori/core';
import { transaction, type Database } from '../sqlite';
import { all, num, one, opt, optStr, run, type Row } from './util';

/** Rows per write transaction during import (keeps memory and lock time flat). */
export const DICT_IMPORT_BATCH_ROWS = 2_500;
/** Max bound parameters per lookup statement chunk. */
const LOOKUP_CHUNK = 400;
/** Input chunk size when importing from an in-memory buffer. */
const BUFFER_CHUNK = 1 << 20;

export interface DictImportOptions {
  /** Pre-allocated id (lets callers emit `downloading` progress before import starts). */
  readonly dictId?: string;
  /** Title shown while importing (preset title / file name) until `index.json` is parsed. */
  readonly fallbackTitle?: string;
  readonly attribution?: string;
  readonly sourceUrl?: string;
  readonly indexUrl?: string;
  /** Re-read the whole archive for the in-memory fallback when the streaming decoder fails. */
  readonly readAll?: () => Promise<Uint8Array>;
  readonly now?: number;
}

export interface DictImportProgress {
  readonly dictId: string;
  readonly title: string;
  readonly phase: 'importing' | 'ready' | 'failed';
  readonly processedRows: number;
  readonly error?: string;
}

export type DictImportInput = Uint8Array | AsyncIterable<Uint8Array>;

interface ImportState {
  readonly dictId: string;
  seq: number;
  terms: number;
  pitchRows: number;
  freqRows: number;
  skipped: number;
  index: YomitanIndex | undefined;
  pendingTerms: CompactTermRecord[];
  meta: MetaRowAccumulator;
}

const DICT_COLUMNS = 'id, title, revision, kind, status, priority, enabled, term_count, meta_count, attribution, source_url, index_url, imported_at';
const TERM_COLUMNS = 'dict_id, seq, expression, reading, def_tags, rules, score, sequence_id, redirect_to, senses_json';

function newDictId(): string {
  return `dict_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

function toInfo(r: Row): DictionaryInfo {
  return {
    id: String(r['id']),
    title: String(r['title']),
    revision: String(r['revision']),
    kind: String(r['kind']) as DictionaryKind,
    status: r['status'] === 'ready' ? 'ready' : 'importing',
    priority: num(r['priority']),
    enabled: num(r['enabled']) !== 0,
    termCount: num(r['term_count']),
    metaCount: num(r['meta_count']),
    ...opt('attribution', optStr(r['attribution'])),
    ...opt('sourceUrl', optStr(r['source_url'])),
    ...opt('indexUrl', optStr(r['index_url'])),
    importedAt: num(r['imported_at']),
  };
}

function toTerm(r: Row): CompactTermRecord {
  const expression = String(r['expression']);
  const reading = String(r['reading']);
  let senses: CompactSense[] = [];
  try {
    senses = JSON.parse(String(r['senses_json'])) as CompactSense[];
  } catch {
    senses = [];
  }
  return {
    dictId: String(r['dict_id']),
    seq: num(r['seq']),
    expression,
    reading,
    defTags: String(r['def_tags']),
    rules: String(r['rules']),
    score: num(r['score']),
    sequenceId: num(r['sequence_id']),
    ...opt('redirectTo', optStr(r['redirect_to'])),
    senses,
    keys: termLookupKeys(expression, reading),
  };
}

function toMeta(r: Row): DictMetaRecord | undefined {
  try {
    const entries = JSON.parse(String(r['data_json'])) as unknown;
    if (!Array.isArray(entries)) return undefined;
    const base = { dictId: String(r['dict_id']), expression: String(r['expression']) };
    if (r['mode'] === 'pitch') return { ...base, mode: 'pitch', entries } as DictMetaRecord;
    if (r['mode'] === 'freq') return { ...base, mode: 'freq', entries } as DictMetaRecord;
  } catch {
    // corrupt row: skip
  }
  return undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const marks = (n: number): string => new Array<string>(n).fill('?').join(', ');

async function* bufferChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += BUFFER_CHUNK) yield bytes.subarray(i, i + BUFFER_CHUNK);
}

/** Error raised by our own row / index validation (never retried via the in-memory fallback). */
function contentError(message: string, cause?: unknown): KotoriError {
  return new KotoriError('parse', message, cause === undefined ? undefined : { cause });
}

export class DictionaryRepository {
  constructor(private readonly db: Database) {}

  /** Drop half-finished imports (crash / quit mid-import); cascades to terms and meta. */
  purgeIncompleteImports(): number {
    return run(this.db, "DELETE FROM dictionaries WHERE status = 'importing'").changes;
  }

  /** Ready dictionaries, display order. */
  list(): DictionaryInfo[] {
    return all(this.db, `SELECT ${DICT_COLUMNS} FROM dictionaries WHERE status = 'ready' ORDER BY priority ASC, imported_at ASC, id ASC`).map(toInfo);
  }

  /** Any dictionary (including `importing`) by id. */
  get(id: string): DictionaryInfo | undefined {
    const row = one(this.db, `SELECT ${DICT_COLUMNS} FROM dictionaries WHERE id = ?`, id);
    return row ? toInfo(row) : undefined;
  }

  update(id: string, patch: { readonly enabled?: boolean; readonly priority?: number }): DictionaryInfo {
    const current = this.get(id);
    if (!current || current.status !== 'ready') throw new KotoriError('not-found', `Dictionary ${id} not found`);
    if (patch.priority !== undefined && !Number.isFinite(patch.priority)) throw new KotoriError('invalid-argument', 'priority must be a finite number', { details: { field: 'priority' } });
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new KotoriError('invalid-argument', 'enabled must be a boolean', { details: { field: 'enabled' } });
    const priority = patch.priority !== undefined ? Math.trunc(patch.priority) : current.priority;
    const enabled = patch.enabled ?? current.enabled;
    run(this.db, 'UPDATE dictionaries SET priority = ?, enabled = ? WHERE id = ?', priority, enabled ? 1 : 0, id);
    return { ...current, priority, enabled };
  }

  remove(id: string): void {
    const { changes } = run(this.db, 'DELETE FROM dictionaries WHERE id = ?', id);
    if (changes === 0) throw new KotoriError('not-found', `Dictionary ${id} not found`);
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  /**
   * Stream-import a Yomitan v3 `.zip` (bytes or an async chunk stream). Rows
   * are written in {@link DICT_IMPORT_BATCH_ROWS}-row transactions; on any
   * failure the partial dictionary is removed and the error rethrown.
   */
  async importZipStream(input: DictImportInput, options: DictImportOptions = {}, onProgress?: (p: DictImportProgress) => void): Promise<DictionaryInfo> {
    const dictId = options.dictId ?? newDictId();
    const now = options.now ?? Date.now();
    let title = options.fallbackTitle?.trim() || 'Dictionary';
    run(
      this.db,
      `INSERT INTO dictionaries (${DICT_COLUMNS}) VALUES (?, ?, '', 'term', 'importing', 0, 1, 0, 0, ?, ?, ?, ?)`,
      dictId,
      title,
      options.attribution ?? null,
      options.sourceUrl ?? null,
      options.indexUrl ?? null,
      now,
    );
    const report = (phase: DictImportProgress['phase'], processedRows: number, error?: string): void => {
      if (!onProgress) return;
      try {
        onProgress({ dictId, title, phase, processedRows, ...(error !== undefined ? { error } : {}) });
      } catch {
        // progress listeners never break an import
      }
    };

    let state = this.newState(dictId);
    try {
      try {
        await this.consume(input instanceof Uint8Array ? bufferChunks(input) : input, state, report);
      } catch (error) {
        const canRetry = !(error instanceof KotoriError) && (input instanceof Uint8Array || options.readAll !== undefined);
        if (!canRetry) throw error;
        // Streaming decoder could not handle this archive (e.g. STORED entries with data descriptors): restart in memory.
        this.clearRows(dictId);
        state = this.newState(dictId);
        const bytes = input instanceof Uint8Array ? input : await options.readAll!();
        this.consumeBuffered(bytes, state, report);
      }
      const index = state.index;
      if (!index) throw contentError('index.json is missing or not a supported Yomitan (format 3) index');
      if (state.terms + state.pitchRows + state.freqRows === 0) throw contentError(`${index.title} contains no term or meta rows`);
      title = index.title;
      const info = this.finalize(dictId, index, state, options, now);
      report('ready', state.terms + state.pitchRows + state.freqRows);
      return info;
    } catch (error) {
      try {
        run(this.db, 'DELETE FROM dictionaries WHERE id = ?', dictId);
      } catch {
        // ignore cleanup failure; purgeIncompleteImports handles it on next start
      }
      const wrapped = error instanceof KotoriError ? error : new KotoriError('parse', `Not a readable Yomitan ZIP: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      report('failed', state.terms + state.pitchRows + state.freqRows, wrapped.message);
      throw wrapped;
    }
  }

  private newState(dictId: string): ImportState {
    return { dictId, seq: 0, terms: 0, pitchRows: 0, freqRows: 0, skipped: 0, index: undefined, pendingTerms: [], meta: new MetaRowAccumulator(dictId) };
  }

  private clearRows(dictId: string): void {
    transaction(this.db, () => {
      run(this.db, 'DELETE FROM dict_terms WHERE dict_id = ?', dictId);
      run(this.db, 'DELETE FROM dict_meta WHERE dict_id = ?', dictId);
    });
  }

  /** Per-entry row sink shared by the streaming and in-memory paths. */
  private entrySink(kind: YomitanEntryKind, name: string, state: ImportState, report: (phase: 'importing', rows: number) => void): { push(chunk: Uint8Array): void; end(): void } {
    if (kind === 'index') {
      const parts: Uint8Array[] = [];
      return {
        push: (chunk) => {
          parts.push(chunk.slice());
        },
        end: () => {
          const total = parts.reduce((n, p) => n + p.length, 0);
          const bytes = new Uint8Array(total);
          let off = 0;
          for (const p of parts) {
            bytes.set(p, off);
            off += p.length;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''));
          } catch (error) {
            throw contentError(`${name} is not valid JSON`, error);
          }
          const index = parseYomitanIndex(raw);
          if (!index) throw contentError(`${name} is missing title / revision or has an unsupported format`);
          state.index = index;
        },
      };
    }
    const splitter = new JsonArrayRowSplitter((row) => {
      if (kind === 'term_bank') this.addTerm(row, state, report);
      else this.addMeta(row, state);
    });
    return {
      push: (chunk) => {
        try {
          splitter.push(chunk);
        } catch (error) {
          throw contentError(`${name}: ${error instanceof Error ? error.message : String(error)}`, error);
        }
      },
      end: () => {
        try {
          splitter.end();
        } catch (error) {
          throw contentError(`${name}: ${error instanceof Error ? error.message : String(error)}`, error);
        }
        if (kind === 'term_meta_bank') this.drainMeta(state);
      },
    };
  }

  private addTerm(row: unknown, state: ImportState, report: (phase: 'importing', rows: number) => void): void {
    const rec = parseYomitanTermRow(row, state.dictId, state.seq);
    if (!rec) {
      state.skipped++;
      return;
    }
    state.seq++;
    state.pendingTerms.push(rec);
    if (state.pendingTerms.length >= DICT_IMPORT_BATCH_ROWS) {
      this.flushTerms(state);
      report('importing', state.terms + state.pitchRows + state.freqRows);
    }
  }

  private addMeta(row: unknown, state: ImportState): void {
    const parsed = parseYomitanMetaRow(row);
    if (!parsed) {
      state.skipped++;
      return;
    }
    state.meta.add(parsed);
    if (parsed.mode === 'pitch') state.pitchRows++;
    else state.freqRows++;
    if (state.meta.size >= DICT_IMPORT_BATCH_ROWS) this.drainMeta(state);
  }

  private flushTerms(state: ImportState): void {
    if (state.pendingTerms.length === 0) return;
    const batch = state.pendingTerms;
    state.pendingTerms = [];
    const insert = this.db.prepare(`INSERT INTO dict_terms (${TERM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    transaction(this.db, () => {
      for (const t of batch) {
        insert.run(t.dictId, t.seq, t.expression, t.reading, t.defTags, t.rules, t.score, t.sequenceId, t.redirectTo ?? null, JSON.stringify(t.senses));
      }
    });
    state.terms += batch.length;
  }

  /** Write accumulated meta records, appending to any record already stored for the same key. */
  private drainMeta(state: ImportState): void {
    if (state.meta.size === 0) return;
    const records = state.meta.drain();
    const select = this.db.prepare('SELECT data_json FROM dict_meta WHERE dict_id = ? AND expression = ? AND mode = ?');
    const insert = this.db.prepare('INSERT INTO dict_meta (dict_id, expression, mode, data_json) VALUES (?, ?, ?, ?)');
    const update = this.db.prepare('UPDATE dict_meta SET data_json = ? WHERE dict_id = ? AND expression = ? AND mode = ?');
    transaction(this.db, () => {
      for (const r of records) {
        const existing = select.get(r.dictId, r.expression, r.mode) as { data_json: string } | undefined;
        if (existing) {
          const prev = JSON.parse(existing.data_json) as unknown[];
          update.run(JSON.stringify([...prev, ...r.entries]), r.dictId, r.expression, r.mode);
        } else {
          insert.run(r.dictId, r.expression, r.mode, JSON.stringify(r.entries));
        }
      }
    });
  }

  /** Streaming path: fflate `Unzip` fed chunk by chunk; every callback is synchronous. */
  private async consume(stream: AsyncIterable<Uint8Array>, state: ImportState, report: (phase: 'importing', rows: number) => void): Promise<void> {
    let failure: unknown;
    const unzip = new Unzip((file) => {
      const entry = normalizeZipEntryPath(file.name);
      if (!entry) return; // not started ⇒ fflate skips the entry's data
      const sink = this.entrySink(entry.kind, entry.name, state, report);
      file.ondata = (error, data, final) => {
        if (failure !== undefined) return;
        if (error) {
          failure = error;
          return;
        }
        try {
          if (data.length > 0) sink.push(data);
          if (final) sink.end();
        } catch (e) {
          failure = e;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for await (const chunk of stream) {
      unzip.push(chunk, false);
      if (failure !== undefined) throw failure;
    }
    unzip.push(new Uint8Array(0), true);
    if (failure !== undefined) throw failure;
    this.flushTerms(state);
    this.drainMeta(state);
  }

  /** In-memory fallback: inflate only the entries we need, then feed them through the same sinks. */
  private consumeBuffered(bytes: Uint8Array, state: ImportState, report: (phase: 'importing', rows: number) => void): void {
    const entries = unzipSync(bytes, { filter: (f) => normalizeZipEntryPath(f.name) !== null });
    for (const [rawName, data] of Object.entries(entries)) {
      const entry = normalizeZipEntryPath(rawName);
      if (!entry) continue;
      const sink = this.entrySink(entry.kind, entry.name, state, report);
      sink.push(data);
      sink.end();
    }
    this.flushTerms(state);
    this.drainMeta(state);
  }

  private finalize(dictId: string, index: YomitanIndex, state: ImportState, options: DictImportOptions, now: number): DictionaryInfo {
    return transaction(this.db, () => {
      const previous = all<{ id: string; priority: number; enabled: number }>(
        this.db,
        "SELECT id, priority, enabled FROM dictionaries WHERE title = ? AND status = 'ready' AND id != ? ORDER BY priority ASC",
        index.title,
        dictId,
      );
      const first = previous[0];
      const priority = first ? num(first.priority) : num(one<{ p: number }>(this.db, "SELECT COALESCE(MAX(priority), -1) + 1 AS p FROM dictionaries WHERE status = 'ready'")?.p ?? 0);
      const enabled = first ? num(first.enabled) !== 0 : true;
      const metaCount = num(one<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM dict_meta WHERE dict_id = ?', dictId)?.n ?? 0);
      const kind = inferDictionaryKind({ terms: state.terms, pitch: state.pitchRows, freq: state.freqRows });
      const attribution = options.attribution ?? index.attribution ?? index.author;
      const sourceUrl = options.sourceUrl ?? index.downloadUrl ?? index.url;
      const indexUrl = options.indexUrl ?? index.indexUrl;
      run(
        this.db,
        "UPDATE dictionaries SET title = ?, revision = ?, kind = ?, status = 'ready', priority = ?, enabled = ?, term_count = ?, meta_count = ?, attribution = ?, source_url = ?, index_url = ?, imported_at = ? WHERE id = ?",
        index.title,
        index.revision,
        kind,
        priority,
        enabled ? 1 : 0,
        state.terms,
        metaCount,
        attribution ?? null,
        sourceUrl ?? null,
        indexUrl ?? null,
        now,
        dictId,
      );
      for (const p of previous) run(this.db, 'DELETE FROM dictionaries WHERE id = ?', p.id);
      const info = this.get(dictId);
      if (!info) throw new KotoriError('internal', `Dictionary ${dictId} vanished during import`);
      return info;
    });
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /** Term rows of `dictIds` whose expression or reading is any of `keys`. */
  findTerms(dictIds: readonly string[], keys: readonly string[]): CompactTermRecord[] {
    const uniqueKeys = [...new Set(keys.filter((k) => k !== ''))];
    if (dictIds.length === 0 || uniqueKeys.length === 0) return [];
    const out = new Map<string, CompactTermRecord>();
    const dictMarks = marks(dictIds.length);
    for (const part of chunks(uniqueKeys, LOOKUP_CHUNK)) {
      const km = marks(part.length);
      // `+dict_id` keeps the planner on the expression / reading indexes (never a full PK range scan).
      const rows = all(
        this.db,
        `SELECT ${TERM_COLUMNS} FROM dict_terms WHERE expression IN (${km}) AND +dict_id IN (${dictMarks})
         UNION ALL
         SELECT ${TERM_COLUMNS} FROM dict_terms WHERE reading != '' AND reading IN (${km}) AND +dict_id IN (${dictMarks})`,
        ...part,
        ...dictIds,
        ...part,
        ...dictIds,
      );
      for (const r of rows) {
        const key = `${String(r['dict_id'])}\u0000${num(r['seq'])}`;
        if (!out.has(key)) out.set(key, toTerm(r));
      }
    }
    return [...out.values()];
  }

  /** Meta records of `dictIds` for any of `expressions`. */
  findMeta(dictIds: readonly string[], expressions: readonly string[]): DictMetaRecord[] {
    const unique = [...new Set(expressions.filter((e) => e !== ''))];
    if (dictIds.length === 0 || unique.length === 0) return [];
    const out: DictMetaRecord[] = [];
    const dictMarks = marks(dictIds.length);
    for (const part of chunks(unique, LOOKUP_CHUNK)) {
      const rows = all(this.db, `SELECT dict_id, expression, mode, data_json FROM dict_meta WHERE expression IN (${marks(part.length)}) AND +dict_id IN (${dictMarks})`, ...part, ...dictIds);
      for (const r of rows) {
        const rec = toMeta(r);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  /** Storage-backed `DictionaryLookupSource` snapshot (ready dictionaries; lookups limited to enabled ones). */
  lookupSource(): DictionaryLookupSource {
    const dictionaries = this.list();
    const usable = dictionaries.filter(isUsableDictionary).map((d) => d.id);
    return {
      dictionaries,
      findTerms: async (keys) => this.findTerms(usable, keys),
      findMeta: async (expressions) => this.findMeta(usable, expressions),
    };
  }

  enrichVocab(vocab: readonly VocabEntry[]): Promise<Record<string, VocabEnrichment>> {
    return enrichVocabBatch(vocab, this.lookupSource());
  }

  lookupPrefix(text: string, maxLength = 16): Promise<InstantLookupMatch[]> {
    return lookupPrefixBatch(text, this.lookupSource(), maxLength);
  }
}
