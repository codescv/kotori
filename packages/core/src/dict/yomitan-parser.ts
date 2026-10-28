/**
 * Yomitan v3 dictionary parsing: ZIP entry routing, `index.json`, compact
 * `term_bank` rows (dual-path sense extraction + redirect detection) and
 * strict `term_meta_bank` pitch / frequency rows (spec §4.1).
 *
 * Every function is pure and tolerant: malformed rows return `null` instead of
 * throwing so a single bad row never aborts a 300k-row import.
 */
import type { CompactSense, CompactTermRecord, DictionaryKind, PitchPattern } from '../types';
import { hasKanji, isAllKana, katakanaToHiragana, normalizeZhScript } from './zh-script';

// ---------------------------------------------------------------------------
// ZIP entries
// ---------------------------------------------------------------------------

export type YomitanEntryKind = 'index' | 'term_bank' | 'term_meta_bank';

export interface YomitanZipEntry {
  readonly kind: YomitanEntryKind;
  /** Bank number (`term_bank_12.json` → 12); 0 for `index.json`. */
  readonly bank: number;
  /** Entry name with wrapper directories stripped (`term_bank_12.json`). */
  readonly name: string;
}

/**
 * Route a raw ZIP entry path. Ignores `__MACOSX/`, `.DS_Store`, AppleDouble
 * `._*` files and directories; strips any wrapper directories
 * (`MyDict/term_bank_1.json` → `term_bank_1.json`, BUG-2053). Returns `null`
 * for entries the importer does not need (styles, tag banks, images, …).
 */
export function normalizeZipEntryPath(rawPath: string): YomitanZipEntry | null {
  const path = rawPath.replace(/\\/g, '/').trim();
  if (path === '' || path.endsWith('/')) return null;
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '__MACOSX')) return null;
  const name = parts[parts.length - 1];
  if (name === undefined || name === '.DS_Store' || name.startsWith('._')) return null;
  const lower = name.toLowerCase();
  if (lower === 'index.json') return { kind: 'index', bank: 0, name };
  const term = /^term_bank_(\d+)\.json$/i.exec(name);
  if (term) return { kind: 'term_bank', bank: Number(term[1]), name };
  const meta = /^term_meta_bank_(\d+)\.json$/i.exec(name);
  if (meta) return { kind: 'term_meta_bank', bank: Number(meta[1]), name };
  return null;
}

// ---------------------------------------------------------------------------
// index.json
// ---------------------------------------------------------------------------

export interface YomitanIndex {
  readonly title: string;
  readonly revision: string;
  readonly format: number;
  readonly sequenced?: boolean;
  readonly author?: string;
  readonly url?: string;
  readonly description?: string;
  readonly attribution?: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
  readonly isUpdatable?: boolean;
  readonly indexUrl?: string;
  readonly downloadUrl?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/**
 * Parse `index.json`. Accepts `format` (or legacy `version`) 3, and 2 whose
 * bank shapes are compatible. Returns `null` when the title / revision are
 * missing or the format is unsupported.
 */
export function parseYomitanIndex(raw: unknown): YomitanIndex | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const title = str(o['title']);
  const revision = typeof o['revision'] === 'number' ? String(o['revision']) : str(o['revision']);
  const formatRaw = o['format'] ?? o['version'];
  const format = typeof formatRaw === 'number' ? formatRaw : typeof formatRaw === 'string' ? Number(formatRaw) : NaN;
  if (!title || !revision || (format !== 3 && format !== 2)) return null;
  const out: { -readonly [K in keyof YomitanIndex]: YomitanIndex[K] } = { title, revision, format };
  if (typeof o['sequenced'] === 'boolean') out.sequenced = o['sequenced'];
  if (typeof o['isUpdatable'] === 'boolean') out.isUpdatable = o['isUpdatable'];
  const optional = ['author', 'url', 'description', 'attribution', 'sourceLanguage', 'targetLanguage', 'indexUrl', 'downloadUrl'] as const;
  for (const k of optional) {
    const v = str(o[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Classify a dictionary from its imported row counts. */
export function inferDictionaryKind(counts: { readonly terms: number; readonly pitch: number; readonly freq: number }): DictionaryKind {
  const kinds = [counts.terms > 0, counts.pitch > 0, counts.freq > 0].filter(Boolean).length;
  if (kinds > 1) return 'mixed';
  if (counts.pitch > 0) return 'pitch';
  if (counts.freq > 0) return 'freq';
  return 'term';
}

// ---------------------------------------------------------------------------
// Structured content
// ---------------------------------------------------------------------------

/** Max senses kept per term row. */
export const MAX_SENSES_PER_TERM = 6;
/** Max characters kept per gloss. */
export const MAX_GLOSS_LENGTH = 400;

interface ScNode {
  readonly tag?: string;
  readonly content?: unknown;
  readonly data?: Record<string, unknown>;
  readonly href?: string;
  readonly type?: string;
  readonly text?: string;
}

const BLOCK_TAGS = new Set(['div', 'p', 'li', 'ol', 'ul', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'details', 'summary', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);
const SKIP_TAGS = new Set(['rt', 'rp', 'img', 'image']);

function isNode(v: unknown): v is ScNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dataContent(n: ScNode): string {
  const d = n.data?.['content'];
  return typeof d === 'string' ? d : '';
}

/** Subtrees never part of a gloss: etymology, backlinks, attribution, examples / extra info. */
function isExcludedFromGloss(n: ScNode): boolean {
  const dc = dataContent(n).toLowerCase();
  if (dc === '') return false;
  if (dc.includes('etymology') || dc === 'backlink' || dc.includes('attribution') || dc.includes('source')) return true;
  if (dc.startsWith('example') || dc === 'extra-info' || dc === 'examples') return true;
  return false;
}

function isTagNode(n: ScNode): boolean {
  const dc = dataContent(n).toLowerCase();
  return n.tag === 'span' && (dc === 'tag' || dc === 'tags' || dc.endsWith('-tag') || dc === 'pos' || dc === 'part-of-speech');
}

function children(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function collapse(s: string): string {
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Inline text of a subtree (ruby readings dropped, block boundaries → `\n`). */
function flattenText(v: unknown, opts: { readonly excludeGloss: boolean; readonly tags?: string[] }): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map((c) => flattenText(c, opts)).join('');
  if (!isNode(v)) return '';
  if (v.tag !== undefined && SKIP_TAGS.has(v.tag)) return '';
  if (opts.excludeGloss && isExcludedFromGloss(v)) return '';
  if (opts.tags && isTagNode(v)) {
    const t = collapse(flattenText(v.content, { excludeGloss: true }));
    if (t) opts.tags.push(t);
    return '';
  }
  if (v.tag === 'br') return '\n';
  const inner = flattenText(v.content, opts);
  return v.tag !== undefined && BLOCK_TAGS.has(v.tag) ? `\n${inner}\n` : inner;
}

/** Depth-first search for the first node matching `pred`. */
function findNode(v: unknown, pred: (n: ScNode) => boolean, skip?: (n: ScNode) => boolean): ScNode | undefined {
  if (Array.isArray(v)) {
    for (const c of v) {
      const hit = findNode(c, pred, skip);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isNode(v)) return undefined;
  if (pred(v)) return v;
  if (skip?.(v)) return undefined;
  return findNode(v.content, pred, skip);
}

/** All nodes matching `pred` (not descending into matches). */
function findAll(v: unknown, pred: (n: ScNode) => boolean, out: ScNode[] = []): ScNode[] {
  if (Array.isArray(v)) {
    for (const c of v) findAll(c, pred, out);
    return out;
  }
  if (!isNode(v)) return out;
  if (pred(v)) {
    out.push(v);
    return out;
  }
  findAll(v.content, pred, out);
  return out;
}

function clipGloss(s: string): string {
  const one = s.replace(/\n+/g, '；').replace(/；{2,}/g, '；').replace(/^；|；$/g, '').trim();
  return one.length > MAX_GLOSS_LENGTH ? `${one.slice(0, MAX_GLOSS_LENGTH - 1)}…` : one;
}

function exampleText(n: ScNode | undefined): string {
  if (!n) return '';
  return collapse(flattenText(n.content, { excludeGloss: false })).replace(/\n+/g, ' ');
}

/** First `example-sentence-a` / `-b` pair inside `li` (prefers a shared `example-sentence` wrapper). */
function extractExample(li: ScNode): [string, string] | undefined {
  const wrapper = findNode(li.content, (n) => dataContent(n) === 'example-sentence');
  const scope = wrapper ?? li;
  const a = findNode(scope.content, (n) => dataContent(n) === 'example-sentence-a');
  const b = findNode(scope.content, (n) => dataContent(n) === 'example-sentence-b');
  const ja = exampleText(a);
  const tr = exampleText(b);
  if (!ja || !tr) return undefined;
  return [ja, tr];
}

function makeSense(gloss: string, normalizeZh: boolean, example?: [string, string], tags?: readonly string[]): CompactSense | undefined {
  const g = clipGloss(gloss);
  if (!g) return undefined;
  const out: { gloss: string; examples?: Array<[string, string]>; tags?: string[] } = { gloss: normalizeZh ? normalizeZhScript(g) : g };
  if (example) out.examples = [[example[0], normalizeZh ? normalizeZhScript(example[1]) : example[1]]];
  if (tags && tags.length > 0) out.tags = [...new Set(tags)];
  return out;
}

/** Path 1: Wiktionary / Kaikki `ol[data.content="glosses"] > li`. */
function extractWiktionarySenses(content: unknown, normalizeZh: boolean, out: CompactSense[]): boolean {
  const lists = findAll(content, (n) => n.tag === 'ol' && dataContent(n) === 'glosses');
  if (lists.length === 0) return false;
  for (const ol of lists) {
    for (const li of children(ol.content)) {
      if (out.length >= MAX_SENSES_PER_TERM) return true;
      if (!isNode(li) || li.tag !== 'li') continue;
      const tags: string[] = [];
      const gloss = collapse(flattenText(li.content, { excludeGloss: true, tags }));
      const sense = makeSense(gloss, normalizeZh, extractExample(li), tags);
      if (sense) out.push(sense);
    }
  }
  return true;
}

/** Path 2: generic block flattener for arbitrary Yomitan v3 structured content. */
function extractGenericSenses(content: unknown, normalizeZh: boolean, out: CompactSense[]): void {
  // JMdict / Jitendex style: each `ul|ol[data.content="glossary"]` is one sense.
  const glossaries = findAll(content, (n) => (n.tag === 'ul' || n.tag === 'ol') && dataContent(n) === 'glossary');
  if (glossaries.length > 0) {
    for (const list of glossaries) {
      if (out.length >= MAX_SENSES_PER_TERM) return;
      const items = children(list.content)
        .map((li) => clipGloss(collapse(flattenText(isNode(li) ? li.content : li, { excludeGloss: true }))))
        .filter((s) => s !== '');
      const sense = makeSense(items.join('; '), normalizeZh);
      if (sense) out.push(sense);
    }
    return;
  }
  const lines = collapse(flattenText(content, { excludeGloss: true }))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  for (const line of lines) {
    if (out.length >= MAX_SENSES_PER_TERM) return;
    const sense = makeSense(line, normalizeZh);
    if (sense) out.push(sense);
  }
}

/** `[target, [rules...]]` — Yomitan v3 deinflection / form-of glossary item. */
function asFormOf(item: unknown): string | undefined {
  if (!Array.isArray(item) || item.length !== 2) return undefined;
  const [target, rules] = item as [unknown, unknown];
  if (typeof target !== 'string' || target.trim() === '' || !Array.isArray(rules)) return undefined;
  if (!rules.every((r) => typeof r === 'string')) return undefined;
  return target.trim();
}

/** Link target (`?query=みる&…`) of the first `a` element, for `non-lemma` rows. */
function linkTarget(content: unknown): string | undefined {
  const a = findNode(content, (n) => n.tag === 'a' && typeof n.href === 'string' && n.href.includes('query='));
  if (!a?.href) return undefined;
  const m = /[?&]query=([^&]+)/.exec(a.href);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Extract compact senses from a Yomitan `glossary` array (both paths). */
export function extractCompactSenses(glossary: readonly unknown[], normalizeZh = true): CompactSense[] {
  const out: CompactSense[] = [];
  for (const item of glossary) {
    if (out.length >= MAX_SENSES_PER_TERM) break;
    if (typeof item === 'string') {
      const sense = makeSense(collapse(item), normalizeZh);
      if (sense) out.push(sense);
      continue;
    }
    if (!isNode(item)) continue; // form-of arrays handled by the caller
    if (item.type === 'text' && typeof item.text === 'string') {
      const sense = makeSense(collapse(item.text), normalizeZh);
      if (sense) out.push(sense);
      continue;
    }
    if (item.type === 'image') continue;
    const content = item.type === 'structured-content' ? item.content : item;
    if (!extractWiktionarySenses(content, normalizeZh, out)) extractGenericSenses(content, normalizeZh, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// term_bank rows
// ---------------------------------------------------------------------------

/** Normalised hiragana reading: explicit reading, else the expression when it is kana, else `''`. */
export function normalizeTermReading(expression: string, rawReading: string): string {
  const r = rawReading.trim();
  if (r !== '') return katakanaToHiragana(r);
  return isAllKana(expression) ? katakanaToHiragana(expression) : '';
}

/** Lookup keys for a term (`[expression]` or `[expression, reading]`). */
export function termLookupKeys(expression: string, reading: string): string[] {
  return reading !== '' && reading !== expression ? [expression, reading] : [expression];
}

function splitTags(s: string): string[] {
  return s.split(/[\s,]+/).filter((t) => t !== '');
}

/**
 * Parse one `term_bank` 8-tuple
 * `[expression, reading, definitionTags, rules, score, glossary, sequence, termTags]`
 * into a `CompactTermRecord`. Returns `null` for malformed rows or rows with
 * neither senses nor a redirect.
 */
export function parseYomitanTermRow(row: unknown, dictId: string, seq: number, normalizeZh = true): CompactTermRecord | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [rawExpr, rawReading, rawDefTags, rawRules, rawScore, rawGlossary, rawSequence] = row as unknown[];
  if (typeof rawExpr !== 'string') return null;
  const expression = rawExpr.trim();
  if (expression === '') return null;
  const reading = normalizeTermReading(expression, typeof rawReading === 'string' ? rawReading : '');
  const defTags = typeof rawDefTags === 'string' ? rawDefTags.trim() : '';
  const rules = typeof rawRules === 'string' ? rawRules.trim() : '';
  const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? Math.trunc(rawScore) : 0;
  const sequenceId = typeof rawSequence === 'number' && Number.isFinite(rawSequence) ? Math.trunc(rawSequence) : 0;
  const glossary: unknown[] = Array.isArray(rawGlossary) ? rawGlossary : typeof rawGlossary === 'string' ? [rawGlossary] : [];

  const formOf = glossary.map(asFormOf);
  const pureRedirect = glossary.length > 0 && formOf.every((t) => t !== undefined);
  let redirectTo: string | undefined;
  let senses: CompactSense[] = [];
  if (pureRedirect) {
    redirectTo = formOf[0];
  } else {
    senses = extractCompactSenses(
      glossary.filter((_, i) => formOf[i] === undefined),
      normalizeZh,
    );
    if (splitTags(defTags).includes('non-lemma')) {
      const target = formOf.find((t) => t !== undefined) ?? glossary.map((g) => (isNode(g) ? linkTarget(g.content) : undefined)).find((t) => t !== undefined);
      if (target !== undefined) redirectTo = target;
    }
  }
  if (redirectTo === expression) redirectTo = undefined;
  if (senses.length === 0 && redirectTo === undefined) return null;

  const rec: { -readonly [K in keyof CompactTermRecord]: CompactTermRecord[K] } = {
    dictId,
    seq,
    expression,
    reading,
    defTags,
    rules,
    score,
    sequenceId,
    senses,
    keys: termLookupKeys(expression, reading),
  };
  if (redirectTo !== undefined) rec.redirectTo = redirectTo;
  return rec;
}

// ---------------------------------------------------------------------------
// term_meta_bank rows
// ---------------------------------------------------------------------------

export interface PitchMetaData {
  /** Hiragana. */
  readonly reading: string;
  readonly pitches: readonly PitchPattern[];
}

export interface FreqMetaData {
  /** Hiragana; absent for reading-less rows (e.g. JPDB bare kana `["かける","freq",…]`). */
  readonly reading?: string;
  readonly value: number;
  readonly displayValue: string;
  /** `displayValue` carried the JPDB `㋕` kana-orthography marker. */
  readonly kanaOnly?: boolean;
}

export type ParsedMetaRow =
  | { readonly expression: string; readonly mode: 'pitch'; readonly data: PitchMetaData }
  | { readonly expression: string; readonly mode: 'freq'; readonly data: FreqMetaData };

/**
 * Downstep position from an `H`/`L` pattern string (`"LHL"` → 2, `"HLL"` → 1,
 * `"LHH"` → 0). Returns `undefined` for anything else.
 */
export function pitchPatternToPosition(pattern: string): number | undefined {
  const p = pattern.trim().toUpperCase();
  if (!/^[HL]+$/.test(p)) return undefined;
  for (let i = 0; i + 1 < p.length; i++) if (p[i] === 'H' && p[i + 1] === 'L') return i + 1;
  return p.length === 1 && p === 'H' ? 1 : 0;
}

function numList(v: unknown): number[] | undefined {
  const arr = typeof v === 'number' ? [v] : Array.isArray(v) ? v : [];
  const out = arr.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0);
  return out.length > 0 ? out : undefined;
}

function parsePitch(data: unknown): PitchMetaData | null {
  if (!isNode(data)) return null;
  const o = data as Record<string, unknown>;
  if (typeof o['reading'] !== 'string' || o['reading'].trim() === '' || !Array.isArray(o['pitches'])) return null;
  const pitches: PitchPattern[] = [];
  for (const p of o['pitches'] as unknown[]) {
    if (!isNode(p)) continue;
    const po = p as Record<string, unknown>;
    const raw = po['position'];
    const position =
      typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
        ? raw
        : typeof raw === 'string'
          ? /^\d+$/.test(raw.trim())
            ? Number(raw.trim())
            : pitchPatternToPosition(raw)
          : typeof po['pattern'] === 'string'
            ? pitchPatternToPosition(po['pattern'])
            : undefined;
    if (position === undefined) continue;
    const out: { position: number; nasal?: number[]; devoice?: number[] } = { position };
    const nasal = numList(po['nasal']);
    const devoice = numList(po['devoice']);
    if (nasal) out.nasal = nasal;
    if (devoice) out.devoice = devoice;
    pitches.push(out);
  }
  if (pitches.length === 0) return null;
  return { reading: katakanaToHiragana(o['reading'].trim()), pitches };
}

function freqValue(v: unknown): { value: number; displayValue?: string } | null {
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v };
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseFloat(v.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? { value: n, displayValue: v.trim() } : null;
  }
  if (isNode(v)) {
    const o = v as Record<string, unknown>;
    const inner = freqValue(o['value']);
    if (!inner) return null;
    const dv = o['displayValue'];
    return typeof dv === 'string' && dv.trim() !== '' ? { value: inner.value, displayValue: dv.trim() } : inner;
  }
  return null;
}

function parseFreq(data: unknown): FreqMetaData | null {
  let reading: string | undefined;
  let fv: { value: number; displayValue?: string } | null;
  if (isNode(data) && ('frequency' in data || 'reading' in data)) {
    const o = data as Record<string, unknown>;
    if (typeof o['reading'] === 'string' && o['reading'].trim() !== '') reading = katakanaToHiragana(o['reading'].trim());
    fv = freqValue('frequency' in o ? o['frequency'] : o);
  } else {
    fv = freqValue(data);
  }
  if (!fv) return null;
  const displayValue = fv.displayValue ?? String(fv.value);
  const out: { reading?: string; value: number; displayValue: string; kanaOnly?: boolean } = { value: fv.value, displayValue };
  if (reading !== undefined) out.reading = reading;
  if (displayValue.includes('㋕')) out.kanaOnly = true;
  return out;
}

/** Parse one `term_meta_bank` row `[expression, 'pitch' | 'freq', data]`; other modes → `null`. */
export function parseYomitanMetaRow(row: unknown): ParsedMetaRow | null {
  if (!Array.isArray(row) || row.length < 3) return null;
  const [rawExpr, mode, data] = row as unknown[];
  if (typeof rawExpr !== 'string' || rawExpr.trim() === '') return null;
  const expression = rawExpr.trim();
  if (mode === 'pitch') {
    const d = parsePitch(data);
    return d ? { expression, mode, data: d } : null;
  }
  if (mode === 'freq') {
    const d = parseFreq(data);
    return d ? { expression, mode, data: d } : null;
  }
  return null;
}

/** Stored meta: all rows of one `(dictId, expression, mode)` merged into one record. */
export type DictMetaRecord =
  | { readonly dictId: string; readonly expression: string; readonly mode: 'pitch'; readonly entries: readonly PitchMetaData[] }
  | { readonly dictId: string; readonly expression: string; readonly mode: 'freq'; readonly entries: readonly FreqMetaData[] };

/**
 * Accumulates parsed meta rows per `(expression, mode)` so a host writes one
 * record per key (JPDB 338k rows → ~180k records). Draining once per bank
 * keeps memory bounded; a host that drains mid-bank MUST merge a drained
 * record into any already-stored record with the same key (append entries)
 * rather than overwrite it.
 */
export class MetaRowAccumulator {
  private readonly pitch = new Map<string, PitchMetaData[]>();
  private readonly freq = new Map<string, FreqMetaData[]>();

  constructor(private readonly dictId: string) {}

  add(row: ParsedMetaRow): void {
    if (row.mode === 'pitch') {
      const list = this.pitch.get(row.expression);
      if (list) list.push(row.data);
      else this.pitch.set(row.expression, [row.data]);
    } else {
      const list = this.freq.get(row.expression);
      if (list) list.push(row.data);
      else this.freq.set(row.expression, [row.data]);
    }
  }

  get size(): number {
    return this.pitch.size + this.freq.size;
  }

  /** Records accumulated so far; the accumulator is cleared. */
  drain(): DictMetaRecord[] {
    const out: DictMetaRecord[] = [];
    for (const [expression, entries] of this.pitch) out.push({ dictId: this.dictId, expression, mode: 'pitch', entries });
    for (const [expression, entries] of this.freq) out.push({ dictId: this.dictId, expression, mode: 'freq', entries });
    this.pitch.clear();
    this.freq.clear();
    return out;
  }
}

/** Whether a term's expression is a kana-only spelling (used by the orthography guard). */
export function isKanaExpression(expression: string): boolean {
  return !hasKanji(expression) && isAllKana(expression);
}
