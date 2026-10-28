/**
 * Android dictionary engine (`host.dict`) over IndexedDB — the WebView
 * counterpart of the desktop SQLite repository. Parsing / enrichment logic
 * lives in `@kotori/core/dict`; this module owns storage and streaming import.
 *
 * Stores (`storage/idb.ts`, v2): `dictionaries` (`DictionaryInfo`),
 * `dictTerms` (`CompactTermRecord`, keyPath `[dictId, seq]`, multiEntry
 * `byKey` over `keys`) and `dictMeta` (`DictMetaRecord`, keyPath
 * `[dictId, expression, mode]`, index `byExprMode`).
 *
 * Import is streaming and blue-green: rows go under a fresh `dictId` whose
 * `dictionaries` row stays `status: 'importing'` (invisible to lookups) until
 * one final transaction flips it to `ready` and drops any older dictionary
 * with the same title. The archive is read chunk by chunk (fflate `Unzip`),
 * every bank entry is split into rows by `JsonArrayRowSplitter`, and parsed
 * rows are flushed to IndexedDB in ~2,500-row transactions between chunks, so
 * memory stays flat regardless of dictionary size.
 */
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import {
  JsonArrayRowSplitter,
  KotoriError,
  MetaRowAccumulator,
  enrichVocabBatch,
  findDictPreset,
  inferDictionaryKind,
  lookupPrefixBatch,
  normalizeZipEntryPath,
  parseYomitanIndex,
  parseYomitanMetaRow,
  parseYomitanTermRow,
} from '@kotori/core';
import type {
  CompactTermRecord,
  DictMetaRecord,
  DictionaryHost,
  DictionaryImportSource,
  DictionaryInfo,
  DictionaryLookupSource,
  RecommendedDictPreset,
  YomitanIndex,
} from '@kotori/core';
import { uniqueId, type HostContext } from './context';
import { bytesToStream } from './storage/unzip-stream';

/** Rows per IndexedDB write transaction (terms) / meta records per drain. */
export const DICT_BATCH_SIZE = 2_500;
/** Minimum interval between `importing` / `downloading` progress events. */
const PROGRESS_INTERVAL_MS = 250;
/** …unless this many rows were processed since the last event. */
const PROGRESS_ROW_STEP = 25_000;
/** Slice size when feeding whole-buffer (fallback) entries to the row splitter. */
const FALLBACK_SLICE = 256 * 1024;
/** Default `lookupPrefix` scan length. */
const DEFAULT_PREFIX_LENGTH = 16;

export interface AndroidDictionaryService extends DictionaryHost {
  /** Delete every `status: 'importing'` dictionary (and its rows); run at startup. */
  purgeIncompleteImports(): Promise<number>;
  /** Lookup source over the currently installed dictionaries (one snapshot of `list()`). */
  lookupSource(): Promise<DictionaryLookupSource>;
}

/**
 * Key range covering every `[dictId, …]` primary key of `dictTerms` / `dictMeta`.
 * `[dictId]` sorts before any longer array with that prefix and arrays sort
 * after numbers and strings, so `[dictId] … [dictId, []]` is exactly the
 * dictionary's rows (no `'\uffff'` sentinel edge cases).
 */
export function dictKeyRange(dictId: string): IDBKeyRange {
  return IDBKeyRange.bound([dictId], [dictId, []], false, true);
}

function sortDictionaries(list: DictionaryInfo[]): DictionaryInfo[] {
  return list.sort((a, b) => a.priority - b.priority || a.importedAt - b.importedAt);
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function baseName(pathOrUrl: string): string {
  const clean = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl;
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function placeholderTitle(source: DictionaryImportSource, preset: RecommendedDictPreset | undefined): string {
  if (preset) return preset.title;
  const raw = source.fileName ?? (source.filePath ? baseName(source.filePath) : source.url ? baseName(source.url) : '');
  const title = raw.replace(/\.zip$/i, '').trim();
  return title === '' ? 'Dictionary' : title;
}

interface EntrySink {
  push(chunk: Uint8Array): void;
  end(): void;
}

/** Mutable state of one import (reset when falling back to whole-buffer extraction). */
class ImportSession {
  seq = 0;
  pitchRows = 0;
  freqRows = 0;
  index: YomitanIndex | null = null;
  private pendingTerms: CompactTermRecord[] = [];
  private acc: MetaRowAccumulator;
  private drainMeta = false;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private lastEmitRows = 0;

  constructor(
    private readonly ctx: HostContext,
    private readonly dictId: string,
    private readonly title: () => string,
  ) {
    this.acc = new MetaRowAccumulator(dictId);
  }

  get processedRows(): number {
    return this.seq + this.pitchRows + this.freqRows;
  }

  /** Sink for one raw ZIP entry, or `undefined` when the importer does not need it. */
  beginEntry(rawName: string): EntrySink | undefined {
    const entry = normalizeZipEntryPath(rawName);
    if (!entry) return undefined;
    if (entry.kind === 'index') {
      const parts: Uint8Array[] = [];
      let size = 0;
      return {
        push: (chunk) => {
          parts.push(chunk.slice());
          size += chunk.length;
        },
        end: () => {
          let raw: unknown;
          try {
            raw = JSON.parse(new TextDecoder('utf-8').decode(concatBytes(parts, size)));
          } catch {
            return; // invalid index.json ⇒ finalize fails with "no valid index"
          }
          const parsed = parseYomitanIndex(raw);
          // A nested duplicate index.json never overrides a valid one.
          if (parsed && !this.index) this.index = parsed;
        },
      };
    }
    if (entry.kind === 'term_bank') {
      const splitter = new JsonArrayRowSplitter((row) => {
        const rec = parseYomitanTermRow(row, this.dictId, this.seq);
        if (rec) {
          this.seq += 1;
          this.pendingTerms.push(rec);
        }
      });
      return { push: (c) => splitter.push(c), end: () => splitter.end() };
    }
    const splitter = new JsonArrayRowSplitter((row) => {
      const parsed = parseYomitanMetaRow(row);
      if (!parsed) return;
      if (parsed.mode === 'pitch') this.pitchRows += 1;
      else this.freqRows += 1;
      this.acc.add(parsed);
    });
    return {
      push: (c) => splitter.push(c),
      end: () => {
        splitter.end();
        this.drainMeta = true;
      },
    };
  }

  /** Persist buffered rows when a batch is full (or everything when `force`). */
  async flush(force: boolean): Promise<void> {
    const { db } = this.ctx;
    while (this.pendingTerms.length >= DICT_BATCH_SIZE || (force && this.pendingTerms.length > 0)) {
      const batch = this.pendingTerms.splice(0, DICT_BATCH_SIZE);
      const tx = db.transaction('dictTerms', 'readwrite');
      await Promise.all([...batch.map((rec) => tx.store.put(rec)), tx.done]);
    }
    if (this.acc.size > 0 && (force || this.drainMeta || this.acc.size >= DICT_BATCH_SIZE)) {
      await this.writeMeta(this.acc.drain());
    }
    this.drainMeta = false;
    this.maybeEmit();
  }

  /** Write drained meta records, merging into already-stored records with the same key. */
  private async writeMeta(records: readonly DictMetaRecord[]): Promise<void> {
    const tx = this.ctx.db.transaction('dictMeta', 'readwrite');
    const existing = await Promise.all(records.map((r) => tx.store.get([r.dictId, r.expression, r.mode])));
    const puts = records.map((rec, i) => {
      const prev = existing[i];
      const merged = prev && prev.mode === rec.mode ? ({ ...rec, entries: [...prev.entries, ...rec.entries] } as DictMetaRecord) : rec;
      return tx.store.put(merged);
    });
    await Promise.all([...puts, tx.done]);
  }

  private maybeEmit(): void {
    const now = this.ctx.deps.now();
    const rows = this.processedRows;
    if (now - this.lastEmitAt < PROGRESS_INTERVAL_MS && rows - this.lastEmitRows < PROGRESS_ROW_STEP) return;
    this.lastEmitAt = now;
    this.lastEmitRows = rows;
    this.ctx.emit({ type: 'dict-import-progress', dictId: this.dictId, title: this.title(), phase: 'importing', processedRows: rows });
  }
}

/** Stream a ZIP through `session`, flushing between chunks (memory stays ~one chunk + one batch). */
async function ingestStream(session: ImportSession, stream: ReadableStream<Uint8Array>): Promise<void> {
  let failure: unknown;
  const unzipper = new Unzip((file) => {
    if (failure !== undefined) return;
    const sink = session.beginEntry(file.name);
    if (!sink) return; // not started ⇒ fflate skips the entry's data
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
    try {
      file.start();
    } catch (e) {
      failure ??= e;
    }
  });
  unzipper.register(UnzipInflate);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      unzipper.push(value, false);
      if (failure !== undefined) throw failure;
      await session.flush(false);
    }
    unzipper.push(new Uint8Array(0), true);
    if (failure !== undefined) throw failure;
  } finally {
    reader.releaseLock();
  }
  await session.flush(true);
}

/**
 * Whole-buffer fallback for archives the streaming decoder cannot handle
 * (e.g. STORED entries with data descriptors). Inflates one entry at a time.
 */
async function ingestBuffer(session: ImportSession, bytes: Uint8Array): Promise<void> {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      if (!f.name.endsWith('/') && normalizeZipEntryPath(f.name)) names.push(f.name);
      return false;
    },
  });
  for (const name of names) {
    const data = unzipSync(bytes, { filter: (f) => f.name === name })[name];
    const sink = data ? session.beginEntry(name) : undefined;
    if (!data || !sink) continue;
    for (let offset = 0; offset < data.length; offset += FALLBACK_SLICE) {
      sink.push(data.subarray(offset, offset + FALLBACK_SLICE));
      await session.flush(false);
    }
    sink.end();
    await session.flush(false);
  }
  await session.flush(true);
}

interface ResolvedArchive {
  readonly open: () => Promise<ReadableStream<Uint8Array>>;
  readonly readAll?: () => Promise<Uint8Array>;
  readonly cleanup?: () => Promise<void>;
}

export function createDictionaryService(ctx: HostContext): AndroidDictionaryService {
  const { db, deps, emit } = ctx;

  const deleteRows = (tx: { objectStore(name: 'dictTerms' | 'dictMeta'): { delete(range: IDBKeyRange): Promise<void> } }, dictId: string): Promise<void>[] => {
    const range = dictKeyRange(dictId);
    return [tx.objectStore('dictTerms').delete(range), tx.objectStore('dictMeta').delete(range)];
  };

  /** Delete one dictionary's rows + record in a single transaction. */
  const purge = async (dictId: string): Promise<void> => {
    const tx = db.transaction(['dictionaries', 'dictTerms', 'dictMeta'], 'readwrite');
    await Promise.all([...deleteRows(tx, dictId), tx.objectStore('dictionaries').delete(dictId), tx.done]);
  };

  const list = async (): Promise<DictionaryInfo[]> => {
    const all = await db.getAll('dictionaries');
    return sortDictionaries(all.filter((d) => d.status === 'ready'));
  };

  const lookupSource = async (): Promise<DictionaryLookupSource> => {
    const dictionaries = await list();
    const usable = new Set(dictionaries.filter((d) => d.status === 'ready' && d.enabled).map((d) => d.id));
    return {
      dictionaries,
      async findTerms(keys) {
        const unique = [...new Set(keys)];
        if (unique.length === 0 || usable.size === 0) return [];
        const tx = db.transaction('dictTerms', 'readonly');
        const index = tx.store.index('byKey');
        const results = await Promise.all(unique.map((k) => index.getAll(k)));
        await tx.done;
        const seen = new Set<string>();
        const out: CompactTermRecord[] = [];
        for (const rows of results) {
          for (const rec of rows) {
            if (!usable.has(rec.dictId)) continue;
            const id = `${rec.dictId}\u0000${rec.seq}`;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push(rec);
          }
        }
        return out;
      },
      async findMeta(expressions) {
        const unique = [...new Set(expressions)];
        if (unique.length === 0 || usable.size === 0) return [];
        const tx = db.transaction('dictMeta', 'readonly');
        const index = tx.store.index('byExprMode');
        const results = await Promise.all(unique.flatMap((e) => [index.getAll([e, 'pitch']), index.getAll([e, 'freq'])]));
        await tx.done;
        return results.flat().filter((m) => usable.has(m.dictId));
      },
    };
  };

  const resolveArchive = async (source: DictionaryImportSource, dictId: string, preset: RecommendedDictPreset | undefined, title: string): Promise<ResolvedArchive> => {
    if (source.bytes) {
      const bytes = source.bytes;
      return { open: async () => bytesToStream(bytes), readAll: async () => bytes };
    }
    if (source.filePath) {
      const path = source.filePath;
      return { open: () => deps.readFileStream(path), readAll: () => deps.fs.readFile(path) };
    }
    const url = source.url ?? preset?.downloadUrl;
    if (!url) throw new KotoriError('invalid-argument', 'importZip needs one of bytes, filePath, url or presetId');
    emit({ type: 'dict-import-progress', dictId, title, phase: 'downloading', processedRows: 0 });
    try {
      if (deps.downloadToFile) {
        const dir = `${deps.dataRoot}/cache/dict`;
        const tmp = `${dir}/${dictId}.zip`;
        await deps.fs.mkdir(dir);
        let lastAt = deps.now();
        const cleanup = async (): Promise<void> => {
          await deps.fs.remove(tmp).catch(() => undefined);
        };
        try {
          await deps.downloadToFile(url, tmp, {
            signal: new AbortController().signal,
            // Heartbeat only: `processedRows` counts rows, so it stays 0 while downloading (same as desktop).
            onProgress: () => {
              const now = deps.now();
              if (now - lastAt < PROGRESS_INTERVAL_MS) return;
              lastAt = now;
              emit({ type: 'dict-import-progress', dictId, title, phase: 'downloading', processedRows: 0 });
            },
          });
        } catch (error) {
          await cleanup();
          throw error;
        }
        return { open: () => deps.readFileStream(tmp), readAll: () => deps.fs.readFile(tmp), cleanup };
      }
      const res = await deps.fetch(url);
      if (!res.ok) throw new KotoriError('network', `dictionary download failed (HTTP ${res.status}): ${url}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { open: async () => bytesToStream(bytes), readAll: async () => bytes };
    } catch (error) {
      throw KotoriError.wrap(error, 'network');
    }
  };

  /** Mark `dictId` ready and drop older dictionaries with the same title — one transaction. */
  const finalize = async (dictId: string, session: ImportSession, source: DictionaryImportSource, preset: RecommendedDictPreset | undefined): Promise<DictionaryInfo> => {
    const index = session.index;
    if (!index) throw new KotoriError('parse', 'not a Yomitan dictionary: index.json missing or invalid');
    const tx = db.transaction(['dictionaries', 'dictTerms', 'dictMeta'], 'readwrite');
    const dicts = tx.objectStore('dictionaries');
    const all = await dicts.getAll();
    const ready = all.filter((d) => d.status === 'ready' && d.id !== dictId);
    const previous = sortDictionaries(ready.filter((d) => d.title === index.title))[0];
    // Stored (merged per expression + mode) meta records, matching the desktop `dict_meta` row count.
    const metaCount = await tx.objectStore('dictMeta').count(dictKeyRange(dictId));
    const attribution = source.attribution ?? preset?.attribution ?? index.attribution ?? index.author;
    const indexUrl = source.indexUrl ?? preset?.indexUrl ?? index.indexUrl;
    const sourceUrl = source.url ?? preset?.downloadUrl ?? index.downloadUrl;
    const info: DictionaryInfo = {
      id: dictId,
      title: index.title,
      revision: index.revision,
      kind: inferDictionaryKind({ terms: session.seq, pitch: session.pitchRows, freq: session.freqRows }),
      status: 'ready',
      priority: previous ? previous.priority : ready.reduce((max, d) => Math.max(max, d.priority), -1) + 1,
      enabled: previous ? previous.enabled : true,
      termCount: session.seq,
      metaCount,
      ...(attribution !== undefined ? { attribution } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(indexUrl !== undefined ? { indexUrl } : {}),
      importedAt: deps.now(),
    };
    const ops: Promise<unknown>[] = [dicts.put(info)];
    for (const old of ready.filter((d) => d.title === index.title)) ops.push(...deleteRows(tx, old.id), dicts.delete(old.id));
    await Promise.all([...ops, tx.done]);
    return info;
  };

  const importZip = async (source: DictionaryImportSource): Promise<DictionaryInfo> => {
    let preset: RecommendedDictPreset | undefined;
    if (source.presetId !== undefined) {
      preset = findDictPreset(source.presetId);
      if (!preset) throw new KotoriError('invalid-argument', `unknown dictionary preset: ${source.presetId}`);
    }
    if (!source.bytes && !source.filePath && !source.url && !preset) {
      throw new KotoriError('invalid-argument', 'importZip needs one of bytes, filePath, url or presetId');
    }
    const dictId = uniqueId('dict', deps.now());
    let title = placeholderTitle(source, preset);
    await db.put('dictionaries', {
      id: dictId,
      title,
      revision: '',
      kind: preset?.kind ?? 'term',
      status: 'importing',
      priority: 0,
      enabled: true,
      termCount: 0,
      metaCount: 0,
      importedAt: deps.now(),
    });
    let archive: ResolvedArchive | undefined;
    let session: ImportSession | undefined;
    try {
      archive = await resolveArchive(source, dictId, preset, title);
      emit({ type: 'dict-import-progress', dictId, title, phase: 'importing', processedRows: 0 });
      const newSession = (): ImportSession => new ImportSession(ctx, dictId, () => session?.index?.title ?? title);
      session = newSession();
      try {
        await ingestStream(session, await archive.open());
      } catch (error) {
        // IndexedDB failures (quota, aborted tx) won't be fixed by re-reading the archive.
        if (!archive.readAll || error instanceof DOMException) throw error;
        console.warn('[kotori:host-android] streaming dictionary import failed, retrying in-memory', error);
        const tx = db.transaction(['dictTerms', 'dictMeta'], 'readwrite');
        await Promise.all([...deleteRows(tx, dictId), tx.done]);
        session = newSession();
        await ingestBuffer(session, await archive.readAll());
      }
      if (session.index) title = session.index.title;
      const info = await finalize(dictId, session, source, preset);
      emit({ type: 'dict-import-progress', dictId, title: info.title, phase: 'ready', processedRows: session.processedRows });
      return info;
    } catch (error) {
      const failure = KotoriError.wrap(error, 'parse');
      await purge(dictId).catch((e: unknown) => {
        console.warn('[kotori:host-android] failed to purge aborted dictionary import', e);
      });
      emit({ type: 'dict-import-progress', dictId, title, phase: 'failed', processedRows: session?.processedRows ?? 0, error: failure.message });
      throw failure;
    } finally {
      await archive?.cleanup?.();
    }
  };

  return {
    list,
    importZip,
    async update(id, patch) {
      const tx = db.transaction('dictionaries', 'readwrite');
      const current = await tx.store.get(id);
      if (!current) {
        await tx.done.catch(() => undefined);
        throw new KotoriError('not-found', `dictionary not found: ${id}`);
      }
      const next: DictionaryInfo = {
        ...current,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      };
      await tx.store.put(next);
      await tx.done;
      return next;
    },
    async remove(id) {
      if ((await db.get('dictionaries', id)) === undefined) throw new KotoriError('not-found', `dictionary not found: ${id}`);
      await purge(id);
    },
    async enrichVocab(vocab) {
      return enrichVocabBatch(vocab, await lookupSource());
    },
    async lookupPrefix(text, maxLength = DEFAULT_PREFIX_LENGTH) {
      return lookupPrefixBatch(text, await lookupSource(), maxLength);
    },
    async purgeIncompleteImports() {
      const tx = db.transaction(['dictionaries', 'dictTerms', 'dictMeta'], 'readwrite');
      const dicts = tx.objectStore('dictionaries');
      const stale = (await dicts.getAll()).filter((d) => d.status === 'importing');
      await Promise.all([...stale.flatMap((d) => [...deleteRows(tx, d.id), dicts.delete(d.id)]), tx.done]);
      // Leftover partial downloads from an interrupted import.
      await deps.fs.remove(`${deps.dataRoot}/cache/dict`).catch(() => undefined);
      return stale.length;
    },
    lookupSource,
  };
}
