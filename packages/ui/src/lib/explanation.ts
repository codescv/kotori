/**
 * Explanation helpers: `chunkIndexAt` / `findChunkAt` / `findVocabAt` come from
 * `@kotori/core` (O(log n), gap clicks → nearest chunk right, else left); the
 * rest are UI-only conveniences for the breakdown panel.
 */
import type { CharSpan, GrammarPoint, SemanticChunk, SentenceExplanation, VocabEntry } from '@kotori/core';

export { chunkIndexAt, findChunkAt, findVocabAt } from '@kotori/core';

const isEmpty = (span: CharSpan): boolean => span[1] <= span[0];

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
