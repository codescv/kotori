/**
 * Convert validated raw model output into the `SentenceExplanation` contract
 * (ids, spans, ruby, cross references) and query it by character index.
 */
import type { CharSpan, ExplainRequest, GrammarPoint, SemanticChunk, SentenceExplanation, SpokenEvolution, TokenUsage, VocabEntry } from '../types';
import { normaliseJapanese, isPunctuationOrSpace } from '../util/text';
import { explanationCacheKeySync } from './cache-key';
import type { RawExplanation } from './explain-schema';
import { PROMPT_VERSION } from './prompts';
import { buildRuby, sliceRuby } from './ruby';
import { alignSpans } from './span-align';

export interface ExplanationMeta {
  readonly model: string;
  readonly usage?: TokenUsage | undefined;
  /** Epoch ms used for `createdAt`. */
  readonly now: number;
  /** Precomputed cache key (`explanationCacheKey`); defaults to the sync fnv key. */
  readonly id?: string;
  readonly promptVersion?: string;
  readonly fromCache?: boolean;
}

/** Spoken evolution is kept only when the surface really differs from the textbook form. */
function evolutionFor(surface: string, textbookForm: string, raw: RawExplanation['chunks'][number]['spokenEvolution']): SpokenEvolution | undefined {
  if (!raw || (!raw.kind && !raw.derivation)) return undefined;
  if (normaliseJapanese(surface) === normaliseJapanese(textbookForm)) return undefined;
  const out: { kind: string; derivation: string; formality?: number } = { kind: raw.kind, derivation: raw.derivation };
  if (raw.formality !== undefined) out.formality = Math.min(1, Math.max(0, raw.formality));
  return out;
}

/**
 * Resolve grammar `chunkSurfaces` to chunk ids: exact surface match, then
 * normalised match, then containment either way. Order-preserving, deduped.
 */
function resolveChunkIds(surfaces: readonly string[], chunks: readonly SemanticChunk[]): string[] {
  const ids: string[] = [];
  for (const s of surfaces) {
    if (!s) continue;
    const n = normaliseJapanese(s);
    const hit =
      chunks.find((c) => c.surface === s) ??
      chunks.find((c) => normaliseJapanese(c.surface) === n) ??
      (n ? chunks.find((c) => { const cn = normaliseJapanese(c.surface); return cn !== '' && (cn.includes(n) || n.includes(cn)); }) : undefined);
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

/**
 * Build a `SentenceExplanation` from validated model output. Chunks are
 * aligned on the sentence; vocab is aligned inside its chunk (sentence
 * coordinates). Ids are `c0..`, `v0..`, `g0..`.
 */
export function toSentenceExplanation(raw: RawExplanation, req: Pick<ExplainRequest, 'sentence' | 'targetLanguage'>, meta: ExplanationMeta): SentenceExplanation {
  const sentence = req.sentence;
  const promptVersion = meta.promptVersion ?? PROMPT_VERSION;
  const ruby = buildRuby(sentence, raw.ruby);
  const chunkAlign = alignSpans(
    sentence,
    raw.chunks.map((c) => c.surface),
  );

  const chunks: SemanticChunk[] = [];
  const vocab: VocabEntry[] = [];
  raw.chunks.forEach((rc, ci) => {
    const span = chunkAlign.spans[ci] ?? ([0, 0] as CharSpan);
    const alignment = chunkAlign.alignment[ci] ?? 'unaligned';
    const surface = alignment === 'unaligned' ? rc.surface : sentence.slice(span[0], span[1]);
    const textbookForm = rc.textbookForm.trim() || surface;
    const chunkText = sentence.slice(span[0], span[1]);
    const vAlign = alignSpans(
      chunkText,
      rc.vocab.map((v) => v.surface),
    );
    const vocabIds: string[] = [];
    rc.vocab.forEach((rv, vi) => {
      const local = vAlign.spans[vi] ?? ([0, 0] as CharSpan);
      const vAlignment = alignment === 'unaligned' ? 'unaligned' : (vAlign.alignment[vi] ?? 'unaligned');
      const vSpan: CharSpan = [span[0] + local[0], span[0] + local[1]];
      const id = `v${vocab.length}`;
      vocabIds.push(id);
      const entry: { -readonly [K in keyof VocabEntry]: VocabEntry[K] } = {
        id,
        charSpan: vSpan,
        alignment: vAlignment,
        surface: vAlignment === 'unaligned' ? rv.surface : sentence.slice(vSpan[0], vSpan[1]),
        lemma: rv.lemma || rv.surface,
        lemmaReading: rv.lemmaReading,
        lemmaRuby: buildRuby(rv.lemma || rv.surface, rv.lemmaRuby),
        partOfSpeech: rv.partOfSpeech,
        meaning: rv.meaning,
      };
      if (rv.conjugation !== undefined) entry.conjugation = rv.conjugation;
      if (rv.jlpt !== undefined) entry.jlpt = rv.jlpt;
      if (rv.pitchAccent !== undefined) entry.pitchAccent = Math.trunc(rv.pitchAccent);
      if (rv.notes !== undefined) entry.notes = rv.notes;
      vocab.push(entry);
    });
    const chunk: { -readonly [K in keyof SemanticChunk]: SemanticChunk[K] } = {
      id: `c${ci}`,
      charSpan: span,
      alignment,
      surface,
      reading: rc.reading,
      ruby: sliceRuby(ruby, span),
      textbookForm,
      role: rc.role,
      meaning: rc.meaning,
      vocabIds,
    };
    const evo = evolutionFor(surface, textbookForm, rc.spokenEvolution);
    if (evo) chunk.spokenEvolution = evo;
    if (rc.nuance !== undefined) chunk.nuance = rc.nuance;
    chunks.push(chunk);
  });

  const grammar: GrammarPoint[] = raw.grammar.map((g, gi) => {
    const gp: { -readonly [K in keyof GrammarPoint]: GrammarPoint[K] } = {
      id: `g${gi}`,
      pattern: g.pattern,
      chunkIds: resolveChunkIds(g.chunkSurfaces, chunks),
      explanation: g.explanation,
    };
    if (g.jlpt !== undefined) gp.jlpt = g.jlpt;
    return gp;
  });

  const expl: { -readonly [K in keyof SentenceExplanation]: SentenceExplanation[K] } = {
    id: meta.id ?? explanationCacheKeySync({ sentence, targetLanguage: req.targetLanguage, model: meta.model, promptVersion }),
    sentence,
    ruby,
    translation: raw.translation,
    chunks,
    vocab,
    grammar,
    targetLanguage: req.targetLanguage,
    model: meta.model,
    promptVersion,
    createdAt: meta.now,
    fromCache: meta.fromCache ?? false,
  };
  if (raw.literalTranslation !== undefined) expl.literalTranslation = raw.literalTranslation;
  if (raw.register !== undefined) expl.register = raw.register;
  if (raw.tone !== undefined) expl.tone = raw.tone;
  if (meta.usage !== undefined) expl.usage = meta.usage;
  return expl;
}

/** Memoised sorted views (keyed by the immutable chunk / vocab array) keep lookups O(log n). */
const sortedCache = new WeakMap<object, { item: { readonly charSpan: CharSpan }; index: number }[]>();

/** Items with a non-empty span, sorted by start (stable). Memoised per array. */
function highlightable<T extends { readonly charSpan: CharSpan }>(items: readonly T[]): { item: T; index: number }[] {
  const hit = sortedCache.get(items);
  if (hit) return hit as { item: T; index: number }[];
  const sorted = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.charSpan[1] > item.charSpan[0])
    .sort((a, b) => a.item.charSpan[0] - b.item.charSpan[0]);
  sortedCache.set(items, sorted);
  return sorted;
}

/** Binary search: last entry whose start ≤ `charIndex`, or -1. */
function lastStartingAtOrBefore<T extends { readonly charSpan: CharSpan }>(sorted: readonly { item: T }[], charIndex: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid]?.item.charSpan[0] ?? 0) <= charIndex) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Index into `expl.chunks` of the chunk for a click at `charIndex`, or -1
 * when there are no highlightable chunks. A click inside a chunk returns it;
 * a click between chunks (whitespace / punctuation / uncovered text) returns
 * the nearest chunk to the right, else the last chunk to the left. O(log n).
 */
export function chunkIndexAt(expl: Pick<SentenceExplanation, 'chunks'>, charIndex: number): number {
  const sorted = highlightable(expl.chunks);
  if (sorted.length === 0) return -1;
  const k = lastStartingAtOrBefore(sorted, charIndex);
  const at = sorted[k];
  if (at && charIndex < at.item.charSpan[1]) return at.index;
  const right = sorted[k + 1];
  if (right) return right.index;
  return sorted[sorted.length - 1]?.index ?? -1;
}

/** Chunk for a click at `charIndex` (see `chunkIndexAt`). */
export function findChunkAt(expl: Pick<SentenceExplanation, 'chunks'>, charIndex: number): SemanticChunk | undefined {
  const i = chunkIndexAt(expl, charIndex);
  return i < 0 ? undefined : expl.chunks[i];
}

/** Vocab entry whose span contains `charIndex` (no nearest fallback). */
export function findVocabAt(expl: Pick<SentenceExplanation, 'vocab'>, charIndex: number): VocabEntry | undefined {
  const sorted = highlightable(expl.vocab);
  const k = lastStartingAtOrBefore(sorted, charIndex);
  const at = sorted[k];
  return at && charIndex < at.item.charSpan[1] ? at.item : undefined;
}

/** True when the character at `charIndex` is whitespace or punctuation. */
export function isGapCharAt(sentence: string, charIndex: number): boolean {
  const ch = sentence.charAt(charIndex);
  return ch === '' || isPunctuationOrSpace(ch);
}
