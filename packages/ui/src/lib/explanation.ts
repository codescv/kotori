/**
 * UI-local explanation helpers mirroring `@kotori/core/ai/explanation.ts`
 * (`findChunkAt`, `chunkIndexAt`, `findVocabAt`). Pure and O(log n).
 */
import type { CharSpan, GrammarPoint, SemanticChunk, SentenceExplanation, VocabEntry } from '@kotori/core';

const isEmpty = (span: CharSpan): boolean => span[1] <= span[0];

/**
 * Index of the chunk covering `charIndex`. A click on whitespace/punctuation
 * between chunks resolves to the nearest chunk to the right, else to the left.
 * Unaligned (empty-span) chunks are never hit. Returns -1 when nothing matches.
 */
export function chunkIndexAt(expl: Pick<SentenceExplanation, 'chunks'>, charIndex: number): number {
  const chunks = expl.chunks;
  // Binary search over non-empty chunks sorted by start.
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid];
    if (!c) break;
    const [s, e] = c.charSpan;
    if (isEmpty(c.charSpan)) {
      // Fall back to a linear scan around an empty span (rare: unaligned chunks).
      break;
    }
    if (charIndex < s) hi = mid - 1;
    else if (charIndex >= e) lo = mid + 1;
    else return mid;
  }
  // Linear fallback (also handles gaps + unaligned chunks): nearest right, else left.
  let right = -1;
  let left = -1;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c || isEmpty(c.charSpan)) continue;
    const [s, e] = c.charSpan;
    if (charIndex >= s && charIndex < e) return i;
    if (s > charIndex && right < 0) right = i;
    if (e <= charIndex) left = i;
  }
  return right >= 0 ? right : left;
}

export function findChunkAt(expl: Pick<SentenceExplanation, 'chunks'>, charIndex: number): SemanticChunk | undefined {
  const i = chunkIndexAt(expl, charIndex);
  return i >= 0 ? expl.chunks[i] : undefined;
}

export function findVocabAt(expl: Pick<SentenceExplanation, 'vocab'>, charIndex: number): VocabEntry | undefined {
  return expl.vocab.find((v) => !isEmpty(v.charSpan) && charIndex >= v.charSpan[0] && charIndex < v.charSpan[1]);
}

/** Vocab entries linked to a chunk (by id, falling back to span containment). */
export function vocabForChunk(expl: SentenceExplanation, chunk: SemanticChunk): VocabEntry[] {
  const byId = expl.vocab.filter((v) => chunk.vocabIds.includes(v.id));
  if (byId.length > 0) return byId;
  return expl.vocab.filter((v) => v.charSpan[0] >= chunk.charSpan[0] && v.charSpan[1] <= chunk.charSpan[1] && !isEmpty(v.charSpan));
}

export function grammarForChunk(expl: SentenceExplanation, chunkId: string): GrammarPoint[] {
  return expl.grammar.filter((g) => g.chunkIds.includes(chunkId));
}

export function spanContains(span: CharSpan, index: number): boolean {
  return index >= span[0] && index < span[1];
}

/** Circled pitch-accent marker: 0 → ⓪, 1 → ①, … 20 → ⑳; larger values → `[n]`. */
export function pitchAccentMark(n: number): string {
  if (n === 0) return '⓪';
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  return `[${n}]`;
}
