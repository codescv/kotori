/**
 * Render-time AI + dictionary enrichment (spec §4.3). Given the AI's
 * `VocabEntry` (canonical `lemma` / `lemmaReading` / `partOfSpeech` /
 * contextual `meaning`), attach authoritative dictionary senses, pitch accent
 * and corpus frequency WITHOUT ever writing them into the explanation cache.
 *
 * Pipeline per vocab:
 *   - Pitch & frequency: looked up independently by the exact
 *     `(v.lemma, toHiragana(v.lemmaReading))` pair (M5). R1: a kana-only
 *     (`㋕`) frequency is only accepted from that exact pair, and a kanji lemma
 *     never falls back to a reading-less bare-kana row.
 *   - Step 1: exact `expression === lemma` (+ reading filter) with one-hop
 *     redirect resolution (`見る → みる`).
 *   - Step 2: Safe Reading Fallback / Orthography Guard (M3): a kanji lemma
 *     with no exact hit may only fall back to pure-kana headwords read the
 *     same (`分かる → わかる`) or to rows sharing a verified sequence id — never
 *     another kanji homograph (`橋 ↛ 箸`).
 *   - Step 3: per-dictionary-family POS filter (JMdict codes + wty-ja-zh tags),
 *     skipping `non-lemma` shells, with soft fallback when it empties all.
 *   - Step 4: Simplified-normalised bigram / character overlap scoring and a
 *     confidence gate (S1 ≥ 20 and S1 − S2 ≥ 10); otherwise `uncertain` with
 *     every homograph as a `VocabCandidate`.
 */
import type {
  CompactTermRecord,
  DictionaryInfo,
  DictionarySenseGroup,
  FrequencyBadge,
  MergedPitchGroup,
  PartOfSpeech,
  PitchPattern,
  VocabCandidate,
  VocabEnrichment,
  VocabEntry,
} from '../types';
import type { DictMetaRecord, FreqMetaData, PitchMetaData } from './yomitan-parser';
import { hasKanji, isAllKana, katakanaToHiragana, normalizeZhScript } from './zh-script';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** In-memory view of everything fetched for one enrichment batch. */
export interface EnrichContext {
  /** Usable (ready + enabled) dictionaries by id. */
  readonly dictionaries: ReadonlyMap<string, DictionaryInfo>;
  /** Term records by lookup key (expression or reading); deduped by `(dictId, seq)`. */
  readonly termsByKey: ReadonlyMap<string, readonly CompactTermRecord[]>;
  /** Meta records by expression. */
  readonly metaByExpression: ReadonlyMap<string, readonly DictMetaRecord[]>;
}

/** Storage-agnostic batch lookup implemented by each host (SQLite / IndexedDB). */
export interface DictionaryLookupSource {
  /** Installed dictionaries; only `status === 'ready' && enabled` ones are used. */
  readonly dictionaries: readonly DictionaryInfo[];
  /** Every term record whose `keys` contain any of `keys` (one query / transaction). */
  findTerms(keys: readonly string[]): Promise<readonly CompactTermRecord[]>;
  /** Every meta record whose expression is any of `expressions`. */
  findMeta(expressions: readonly string[]): Promise<readonly DictMetaRecord[]>;
}

export function isUsableDictionary(d: DictionaryInfo): boolean {
  return d.status === 'ready' && d.enabled;
}

/** Build an `EnrichContext`, dropping rows from unusable / unknown dictionaries. */
export function buildEnrichContext(dictionaries: readonly DictionaryInfo[], terms: Iterable<CompactTermRecord>, meta: Iterable<DictMetaRecord>): EnrichContext {
  const dicts = new Map<string, DictionaryInfo>();
  for (const d of dictionaries) if (isUsableDictionary(d)) dicts.set(d.id, d);
  const termsByKey = new Map<string, CompactTermRecord[]>();
  const seen = new Set<string>();
  for (const t of terms) {
    if (!dicts.has(t.dictId)) continue;
    const id = `${t.dictId}\u0000${t.seq}`;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const k of new Set([t.expression, ...t.keys])) {
      const list = termsByKey.get(k);
      if (list) list.push(t);
      else termsByKey.set(k, [t]);
    }
  }
  const metaByExpression = new Map<string, DictMetaRecord[]>();
  const seenMeta = new Set<string>();
  for (const m of meta) {
    if (!dicts.has(m.dictId)) continue;
    const id = `${m.dictId}\u0000${m.expression}\u0000${m.mode}`;
    if (seenMeta.has(id)) continue;
    seenMeta.add(id);
    const list = metaByExpression.get(m.expression);
    if (list) list.push(m);
    else metaByExpression.set(m.expression, [m]);
  }
  return { dictionaries: dicts, termsByKey, metaByExpression };
}

function priorityOf(ctx: EnrichContext, dictId: string): number {
  return ctx.dictionaries.get(dictId)?.priority ?? Number.MAX_SAFE_INTEGER;
}

function titleOf(ctx: EnrichContext, dictId: string): string {
  return ctx.dictionaries.get(dictId)?.title ?? dictId;
}

/** Hiragana reading used for lookups: AI reading, else the lemma itself when kana. */
export function lookupReading(lemma: string, lemmaReading: string): string {
  const r = katakanaToHiragana(lemmaReading.trim());
  if (r !== '') return r;
  return isAllKana(lemma) ? katakanaToHiragana(lemma) : '';
}

function isKanaExpression(s: string): boolean {
  return !hasKanji(s) && isAllKana(s);
}

// ---------------------------------------------------------------------------
// Pitch & frequency
// ---------------------------------------------------------------------------

export interface PitchSourceItem {
  readonly reading: string;
  readonly pattern: PitchPattern;
  /** Dictionary title. */
  readonly source: string;
}

function listKey(l: readonly number[] | undefined): string {
  return l && l.length > 0 ? [...l].sort((a, b) => a - b).join(',') : '';
}

/**
 * Merge pitch rows from several dictionaries ONLY when the full payload
 * (`reading + position + nasal + devoice`) is identical, keeping every
 * source title (BUG-2122 / BUG-2397). First-seen order is preserved.
 */
export function mergeIdenticalPitchGroups(items: readonly PitchSourceItem[]): MergedPitchGroup[] {
  const groups = new Map<string, { reading: string; position: number; nasal?: readonly number[]; devoice?: readonly number[]; sources: string[] }>();
  for (const it of items) {
    const key = `${it.reading}|${it.pattern.position}|${listKey(it.pattern.nasal)}|${listKey(it.pattern.devoice)}`;
    const g = groups.get(key);
    if (g) {
      if (!g.sources.includes(it.source)) g.sources.push(it.source);
      continue;
    }
    const ng: { reading: string; position: number; nasal?: readonly number[]; devoice?: readonly number[]; sources: string[] } = {
      reading: it.reading,
      position: it.pattern.position,
      sources: [it.source],
    };
    if (it.pattern.nasal && it.pattern.nasal.length > 0) ng.nasal = [...it.pattern.nasal];
    if (it.pattern.devoice && it.pattern.devoice.length > 0) ng.devoice = [...it.pattern.devoice];
    groups.set(key, ng);
  }
  return [...groups.values()];
}

function metaFor(ctx: EnrichContext, expression: string, mode: 'pitch' | 'freq'): DictMetaRecord[] {
  return (ctx.metaByExpression.get(expression) ?? []).filter((m) => m.mode === mode && ctx.dictionaries.has(m.dictId)).sort((a, b) => priorityOf(ctx, a.dictId) - priorityOf(ctx, b.dictId));
}

/** Pitch groups for the exact `(expression, reading)` pair. */
export function lookupPitches(ctx: EnrichContext, expression: string, reading: string): MergedPitchGroup[] {
  const items: PitchSourceItem[] = [];
  for (const m of metaFor(ctx, expression, 'pitch')) {
    const source = titleOf(ctx, m.dictId);
    for (const e of m.entries as readonly PitchMetaData[]) {
      if (reading !== '' && e.reading !== reading) continue;
      for (const p of e.pitches) items.push({ reading: e.reading, pattern: p, source });
    }
  }
  return mergeIdenticalPitchGroups(items);
}

/**
 * Frequency badges for the exact `(expression, reading)` pair (R1):
 * - rows WITH a reading must match `reading`;
 * - reading-less rows count only when `expression` itself is kana read as
 *   `reading` (they are the kana spelling's own frequency), or — for a kanji
 *   expression — when they are not kana-only (`㋕`) frequencies.
 * Rows of OTHER expressions (e.g. bare `かける` for `賭ける`) are never read.
 */
export function lookupFrequencies(ctx: EnrichContext, expression: string, reading: string): FrequencyBadge[] {
  const out: FrequencyBadge[] = [];
  const kanaExpr = isKanaExpression(expression);
  for (const m of metaFor(ctx, expression, 'freq')) {
    const dictTitle = titleOf(ctx, m.dictId);
    for (const e of m.entries as readonly FreqMetaData[]) {
      if (e.reading !== undefined) {
        if (reading !== '' && e.reading !== reading) continue;
      } else if (kanaExpr) {
        if (reading !== '' && katakanaToHiragana(expression) !== reading) continue;
      } else if (e.kanaOnly) continue;
      const badge: { dictId: string; dictTitle: string; value: number; displayValue: string; kanaOnly?: boolean } = { dictId: m.dictId, dictTitle, value: e.value, displayValue: e.displayValue };
      if (e.kanaOnly) badge.kanaOnly = true;
      out.push(badge);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// POS families
// ---------------------------------------------------------------------------

export type PosClass = 'verb' | 'i-adj' | 'na-adj' | 'noun' | 'suffix' | 'prefix' | 'conj' | 'adverb' | 'interj' | 'pronoun' | 'particle' | 'aux' | 'counter' | 'expr';

const TOKEN_CLASSES: Readonly<Record<string, readonly PosClass[]>> = {
  // wty-ja-zh
  v: ['verb'],
  vi: ['verb'],
  vt: ['verb'],
  ichidan: ['verb'],
  godan: ['verb'],
  suru: ['verb'],
  kuru: ['verb'],
  verb: ['verb'],
  adj: ['i-adj'],
  adj_noun: ['na-adj'],
  adjective: ['i-adj'],
  noun: ['noun'],
  name: ['noun'],
  suf: ['suffix'],
  suffix: ['suffix'],
  pref: ['prefix'],
  prefix: ['prefix'],
  conj: ['conj'],
  conjunction: ['conj'],
  adv: ['adverb'],
  adverb: ['adverb'],
  intj: ['interj'],
  int: ['interj'],
  interj: ['interj'],
  pron: ['pronoun'],
  pronoun: ['pronoun'],
  particle: ['particle'],
  prt: ['particle'],
  phrase: ['expr'],
  // JMdict
  n: ['noun'],
  'n-adv': ['noun', 'adverb'],
  'n-t': ['noun'],
  'n-pr': ['noun'],
  'n-suf': ['noun', 'suffix'],
  'n-pref': ['noun', 'prefix'],
  pn: ['pronoun', 'noun'],
  'adj-i': ['i-adj'],
  'adj-ix': ['i-adj'],
  'adj-na': ['na-adj'],
  'adj-no': ['noun'],
  'adj-t': ['na-adj'],
  'adj-f': ['na-adj'],
  'adv-to': ['adverb'],
  aux: ['aux'],
  'aux-v': ['aux'],
  'aux-adj': ['aux'],
  ctr: ['counter'],
  exp: ['expr'],
  vs: ['verb'],
};

/** Coarse POS classes of a term row from `defTags` + `rules`; empty set = untagged (wildcard). */
export function termPosClasses(rec: Pick<CompactTermRecord, 'defTags' | 'rules'>): Set<PosClass> {
  const out = new Set<PosClass>();
  for (const raw of `${rec.defTags} ${rec.rules}`.toLowerCase().split(/[\s,;]+/)) {
    if (raw === '') continue;
    const direct = TOKEN_CLASSES[raw];
    if (direct) {
      for (const c of direct) out.add(c);
      continue;
    }
    if (/^v(?:1|5|k|s|z|r|n|2|4|-unspec)/.test(raw)) out.add('verb');
    else if (/^adj-/.test(raw)) out.add('na-adj');
  }
  return out;
}

const POS_ACCEPTS: Partial<Record<PartOfSpeech, readonly PosClass[]>> = {
  verb: ['verb'],
  'i-adjective': ['i-adj'],
  'na-adjective': ['na-adj', 'noun'],
  noun: ['noun', 'pronoun'],
  'proper-noun': ['noun'],
  pronoun: ['pronoun', 'noun'],
  suffix: ['suffix'],
  prefix: ['prefix'],
  conjunction: ['conj'],
  adverb: ['adverb'],
  interjection: ['interj'],
  particle: ['particle'],
  auxiliary: ['aux'],
  counter: ['counter', 'suffix'],
};

function isNonLemma(rec: CompactTermRecord): boolean {
  return rec.defTags.split(/[\s,]+/).includes('non-lemma');
}

/** Whether a term row is compatible with the AI part of speech (untagged rows always are). */
export function posCompatible(rec: CompactTermRecord, pos: PartOfSpeech): boolean {
  const accepts = POS_ACCEPTS[pos];
  if (!accepts) return true;
  const classes = termPosClasses(rec);
  if (classes.size === 0) return true;
  return accepts.some((c) => classes.has(c));
}

// ---------------------------------------------------------------------------
// Overlap scoring
// ---------------------------------------------------------------------------

const STOP_CHARS = new Set([...'的了是在和与或之等着地得把被也就都而及其所为个这那有人某']);
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'one', 'someone', 'something', 'that', 'this', 'from', 'into', 'out', 'off', 'not', 'are', 'was', 'its']);

interface OverlapFeatures {
  readonly chars: Set<string>;
  readonly bigrams: Set<string>;
  readonly words: Set<string>;
}

function isContentChar(ch: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch);
}

function features(text: string): OverlapFeatures {
  const norm = normalizeZhScript(text).toLowerCase();
  const chars = new Set<string>();
  const bigrams = new Set<string>();
  let prev = '';
  for (const ch of norm) {
    if (isContentChar(ch)) {
      if (!STOP_CHARS.has(ch)) chars.add(ch);
      if (prev !== '') bigrams.add(prev + ch);
      prev = ch;
    } else prev = '';
  }
  const words = new Set((norm.match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)));
  return { chars, bigrams, words };
}

/**
 * Overlap between the AI contextual meaning and one dictionary gloss, after
 * Traditional → Simplified normalisation: +10 per shared CJK bigram, +5 per
 * shared content character, +10 per shared English word (≥ 3 letters).
 */
export function scoreMeaningOverlap(meaning: string, gloss: string): number {
  const a = features(meaning);
  const b = features(gloss);
  let s = 0;
  for (const bg of a.bigrams) if (b.bigrams.has(bg)) s += 10;
  for (const ch of a.chars) if (b.chars.has(ch)) s += 5;
  for (const w of a.words) if (b.words.has(w)) s += 10;
  return s;
}

/** Confidence gate thresholds (spec §4.3.D). */
export const CONFIDENCE_MIN_SCORE = 20;
export const CONFIDENCE_MIN_MARGIN = 10;

function bestSense(meaning: string, group: DictionarySenseGroup): { idx: number; score: number; unique: boolean } {
  let idx = -1;
  let score = 0;
  let unique = false;
  group.senses.forEach((s, i) => {
    const sc = scoreMeaningOverlap(meaning, s.gloss);
    if (sc > score) {
      score = sc;
      idx = i;
      unique = true;
    } else if (sc === score && sc > 0) unique = false;
  });
  return { idx, score, unique };
}

/** Annotate `matchedSenseIdx` on groups whose best sense clears the gate. */
function withMatchedSense(meaning: string, groups: readonly DictionarySenseGroup[]): DictionarySenseGroup[] {
  return groups.map((g) => {
    const b = bestSense(meaning, g);
    return b.idx >= 0 && b.unique && b.score >= CONFIDENCE_MIN_SCORE ? { ...g, matchedSenseIdx: b.idx } : g;
  });
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

function recordsFor(ctx: EnrichContext, key: string): readonly CompactTermRecord[] {
  return key === '' ? [] : (ctx.termsByKey.get(key) ?? []);
}

/** One-hop redirect resolution inside the same dictionary (`accept` guards the target). */
function resolveRedirect(ctx: EnrichContext, rec: CompactTermRecord, reading: string, accept: (t: CompactTermRecord) => boolean = () => true): CompactTermRecord[] {
  if (rec.redirectTo === undefined) return [rec];
  const target = rec.redirectTo;
  const all = recordsFor(ctx, target).filter((t) => t.dictId === rec.dictId && t.expression === target && t.senses.length > 0 && accept(t));
  const byReading = reading === '' ? all : all.filter((t) => t.reading === '' || t.reading === reading);
  const targets = byReading.length > 0 ? byReading : all;
  if (targets.length > 0) return targets;
  return rec.senses.length > 0 ? [rec] : [];
}

interface HeadwordGroup {
  headword: string;
  reading: string;
  records: CompactTermRecord[];
}

function uniqRecords(recs: readonly CompactTermRecord[]): CompactTermRecord[] {
  const seen = new Set<string>();
  const out: CompactTermRecord[] = [];
  for (const r of recs) {
    const id = `${r.dictId}\u0000${r.seq}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

/**
 * Steps 1–2: records bound to the lemma itself (exact + redirect, else the
 * orthography-guarded reading fallback), evaluated per dictionary so one
 * dictionary's exact hit never hides another dictionary's kana entry.
 */
export function collectLemmaRecords(ctx: EnrichContext, lemma: string, reading: string): CompactTermRecord[] {
  const lemmaHasKanji = hasKanji(lemma);
  const pool = uniqRecords([...recordsFor(ctx, lemma), ...recordsFor(ctx, reading)]);
  const verifiedSeq = new Set(pool.filter((r) => r.expression === lemma && r.sequenceId !== 0).map((r) => `${r.sequenceId}`));
  const out: CompactTermRecord[] = [];
  for (const dictId of ctx.dictionaries.keys()) {
    const inDict = pool.filter((r) => r.dictId === dictId);
    if (inDict.length === 0) continue;
    const exactAll = inDict.filter((r) => r.expression === lemma);
    const exactByReading = lemmaHasKanji && reading !== '' ? exactAll.filter((r) => r.reading === '' || r.reading === reading || r.redirectTo !== undefined) : exactAll;
    const exact = exactByReading.length > 0 ? exactByReading : exactAll;
    const resolved = exact.flatMap((r) => resolveRedirect(ctx, r, reading));
    if (resolved.length > 0) {
      out.push(...resolved);
      continue;
    }
    if (!lemmaHasKanji || reading === '') continue;
    // Step 2 — Orthography Guard: pure-kana headwords read `reading`, or verified same-entry spellings.
    const guard = (r: CompactTermRecord): boolean =>
      r.expression === lemma || (isKanaExpression(r.expression) && katakanaToHiragana(r.expression) === reading) || (r.sequenceId !== 0 && r.reading === reading && verifiedSeq.has(`${r.sequenceId}`));
    const fallback = inDict.filter((r) => r.expression !== lemma && r.keys.includes(reading) && guard(r));
    out.push(...fallback.flatMap((r) => resolveRedirect(ctx, r, reading, guard)));
  }
  return uniqRecords(out);
}

/** Kanji homographs of a kana lemma (`かける` → 賭ける / 掛ける / …), grouped by headword (+ shared sequence id). */
function collectHomographGroups(ctx: EnrichContext, lemma: string, reading: string): HeadwordGroup[] {
  if (hasKanji(lemma) || reading === '') return [];
  const recs = recordsFor(ctx, reading).filter((r) => r.expression !== lemma && hasKanji(r.expression) && r.reading === reading && r.redirectTo === undefined && r.senses.length > 0);
  const groupOf = new Map<string, HeadwordGroup>();
  const bySeq = new Map<string, HeadwordGroup>();
  const groups: HeadwordGroup[] = [];
  const sorted = [...recs].sort((a, b) => priorityOf(ctx, a.dictId) - priorityOf(ctx, b.dictId) || b.score - a.score || a.seq - b.seq);
  for (const r of sorted) {
    const seqKey = r.sequenceId !== 0 ? `${r.dictId}\u0000${r.sequenceId}` : undefined;
    let g = groupOf.get(r.expression) ?? (seqKey ? bySeq.get(seqKey) : undefined);
    if (!g) {
      g = { headword: r.expression, reading, records: [] };
      groups.push(g);
    }
    g.records.push(r);
    groupOf.set(r.expression, g);
    if (seqKey) bySeq.set(seqKey, g);
  }
  return groups;
}

function toSenseGroups(ctx: EnrichContext, recs: readonly CompactTermRecord[]): DictionarySenseGroup[] {
  return uniqRecords(recs)
    .filter((r) => r.senses.length > 0)
    .sort((a, b) => priorityOf(ctx, a.dictId) - priorityOf(ctx, b.dictId) || b.score - a.score || a.seq - b.seq)
    .map((r) => ({ dictId: r.dictId, dictTitle: titleOf(ctx, r.dictId), expression: r.expression, reading: r.reading, defTags: r.defTags, senses: r.senses }));
}

/** Step 3 over all groups, with `non-lemma` skipping and soft fallback. */
function filterGroups(groups: readonly HeadwordGroup[], pos: PartOfSpeech): HeadwordGroup[] {
  const stripNonLemma = (recs: readonly CompactTermRecord[]): CompactTermRecord[] => {
    const lemmas = recs.filter((r) => !isNonLemma(r));
    return lemmas.length > 0 ? lemmas : [...recs];
  };
  const base = groups.map((g) => ({ ...g, records: stripNonLemma(g.records) })).filter((g) => g.records.length > 0);
  const filtered = base.map((g) => ({ ...g, records: g.records.filter((r) => posCompatible(r, pos)) })).filter((g) => g.records.length > 0);
  return filtered.length > 0 ? filtered : base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Enrich one vocab entry from an already-fetched context (synchronous, pure). */
export function enrichSingleVocab(v: Pick<VocabEntry, 'lemma' | 'lemmaReading' | 'partOfSpeech' | 'meaning'>, ctx: EnrichContext): VocabEnrichment {
  const lemma = v.lemma.trim();
  const reading = lookupReading(lemma, v.lemmaReading);
  let pitches = lookupPitches(ctx, lemma, reading);
  const frequencies = lookupFrequencies(ctx, lemma, reading);
  if (lemma === '') return { status: 'empty', pitches, frequencies, senseGroups: [] };

  const lemmaGroup: HeadwordGroup = { headword: lemma, reading, records: collectLemmaRecords(ctx, lemma, reading) };
  const homographs = collectHomographGroups(ctx, lemma, reading);
  let groups: HeadwordGroup[];
  if (homographs.length === 0) groups = [lemmaGroup];
  else if (homographs.length === 1) {
    const only = homographs[0]!;
    groups = [{ headword: lemmaGroup.records.length > 0 ? lemma : only.headword, reading, records: [...lemmaGroup.records, ...only.records] }];
  } else groups = lemmaGroup.records.length > 0 ? [lemmaGroup, ...homographs] : homographs;
  groups = filterGroups(groups, v.partOfSpeech);

  const base = (headword: string): VocabEnrichment => {
    const out: { -readonly [K in keyof VocabEnrichment]: VocabEnrichment[K] } = { status: 'empty', pitches, frequencies, senseGroups: [] };
    if (headword !== '') {
      out.headword = headword;
      out.reading = reading;
    }
    return out;
  };

  if (groups.length === 0) return base('');

  if (groups.length === 1) {
    const g = groups[0]!;
    if (pitches.length === 0 && g.headword !== lemma) pitches = lookupPitches(ctx, g.headword, reading);
    return { ...base(g.headword), status: 'matched', pitches, senseGroups: withMatchedSense(v.meaning, toSenseGroups(ctx, g.records)) };
  }

  // Step 4 — overlap scoring + confidence gate.
  const scored = groups
    .map((g) => {
      const senseGroups = toSenseGroups(ctx, g.records);
      const score = Math.max(0, ...senseGroups.map((sg) => bestSense(v.meaning, sg).score));
      return { g, senseGroups, score };
    })
    .sort((a, b) => b.score - a.score);
  const s1 = scored[0]?.score ?? 0;
  const s2 = scored[1]?.score ?? 0;
  if (s1 >= CONFIDENCE_MIN_SCORE && s1 - s2 >= CONFIDENCE_MIN_MARGIN) {
    const top = scored[0]!;
    if (pitches.length === 0 && top.g.headword !== lemma) pitches = lookupPitches(ctx, top.g.headword, reading);
    return { ...base(top.g.headword), status: 'matched', pitches, senseGroups: withMatchedSense(v.meaning, top.senseGroups) };
  }
  const candidates: VocabCandidate[] = scored.map(({ g, senseGroups }) => ({
    expression: g.headword,
    reading: g.reading,
    pitches: lookupPitches(ctx, g.headword, g.reading),
    frequencies: lookupFrequencies(ctx, g.headword, g.reading),
    senseGroups,
  }));
  return { ...base(lemma), status: 'uncertain', candidates };
}

/** Lookup keys needed for the first batch round. */
export function vocabLookupKeys(vocab: readonly Pick<VocabEntry, 'lemma' | 'lemmaReading'>[]): { termKeys: string[]; metaExpressions: string[] } {
  const termKeys = new Set<string>();
  const metaExpressions = new Set<string>();
  for (const v of vocab) {
    const lemma = v.lemma.trim();
    if (lemma === '') continue;
    const reading = lookupReading(lemma, v.lemmaReading);
    termKeys.add(lemma);
    if (reading !== '') termKeys.add(reading);
    metaExpressions.add(lemma);
  }
  return { termKeys: [...termKeys], metaExpressions: [...metaExpressions] };
}

/**
 * Enrich a batch of vocab with at most two batched lookup rounds:
 * round 1 fetches terms by lemma + reading and meta by lemma; round 2 fetches
 * redirect targets and meta for every other headword seen (homograph
 * candidates). Result keyed by `VocabEntry.id`.
 */
export async function enrichVocabBatch(vocab: readonly VocabEntry[], source: DictionaryLookupSource): Promise<Record<string, VocabEnrichment>> {
  const usable = source.dictionaries.filter(isUsableDictionary);
  const out: Record<string, VocabEnrichment> = {};
  if (usable.length === 0 || vocab.length === 0) {
    for (const v of vocab) out[v.id] = { status: 'empty', pitches: [], frequencies: [], senseGroups: [] };
    return out;
  }
  const { termKeys, metaExpressions } = vocabLookupKeys(vocab);
  const [terms1, meta1] = await Promise.all([termKeys.length > 0 ? source.findTerms(termKeys) : Promise.resolve([]), metaExpressions.length > 0 ? source.findMeta(metaExpressions) : Promise.resolve([])]);
  const haveKeys = new Set(termKeys);
  const haveMeta = new Set(metaExpressions);
  const redirectKeys = new Set<string>();
  const extraMeta = new Set<string>();
  for (const t of terms1) {
    if (t.redirectTo !== undefined && !haveKeys.has(t.redirectTo)) redirectKeys.add(t.redirectTo);
    if (!haveMeta.has(t.expression)) extraMeta.add(t.expression);
  }
  const [terms2, meta2] = await Promise.all([
    redirectKeys.size > 0 ? source.findTerms([...redirectKeys]) : Promise.resolve([]),
    extraMeta.size > 0 ? source.findMeta([...extraMeta]) : Promise.resolve([]),
  ]);
  const ctx = buildEnrichContext(usable, [...terms1, ...terms2], [...meta1, ...meta2]);
  for (const v of vocab) out[v.id] = enrichSingleVocab(v, ctx);
  return out;
}
