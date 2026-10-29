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

/**
 * Partition every vocabulary entry in `explanation.vocab` across chunks with
 * zero dropped items:
 * 1. Explicit `chunk.vocabIds` (preserving `charSpan[0]` order).
 * 2. Full containment fallback (`c.charSpan[0] <= v.charSpan[0] && v.charSpan[1] <= c.charSpan[1]`).
 * 2b. Partial overlap fallback (`c.charSpan[0] < v.charSpan[1] && c.charSpan[1] > v.charSpan[0]`).
 * 3. Remaining unclaimed entries go to `orphans`.
 */
export function partitionVocabByChunk(explanation: SentenceExplanation): {
  readonly byChunk: ReadonlyMap<string, readonly VocabEntry[]>;
  readonly orphans: readonly VocabEntry[];
} {
  const claimedIds = new Set<string>();
  const buckets = new Map<string, VocabEntry[]>();
  for (const c of explanation.chunks) {
    buckets.set(c.id, []);
  }

  for (const c of explanation.chunks) {
    const bucket = buckets.get(c.id)!;
    const matched = explanation.vocab
      .filter((v) => c.vocabIds.includes(v.id))
      .sort((a, b) => a.charSpan[0] - b.charSpan[0]);
    for (const v of matched) {
      bucket.push(v);
      claimedIds.add(v.id);
    }
  }

  for (const v of explanation.vocab) {
    if (claimedIds.has(v.id) || isEmpty(v.charSpan)) continue;
    const containing = explanation.chunks.find(
      (c) => !isEmpty(c.charSpan) && c.charSpan[0] <= v.charSpan[0] && v.charSpan[1] <= c.charSpan[1],
    );
    if (containing) {
      buckets.get(containing.id)!.push(v);
      claimedIds.add(v.id);
    }
  }

  for (const v of explanation.vocab) {
    if (claimedIds.has(v.id) || isEmpty(v.charSpan)) continue;
    const overlapping = explanation.chunks.find(
      (c) => !isEmpty(c.charSpan) && c.charSpan[0] < v.charSpan[1] && c.charSpan[1] > v.charSpan[0],
    );
    if (overlapping) {
      buckets.get(overlapping.id)!.push(v);
      claimedIds.add(v.id);
    }
  }

  for (const list of buckets.values()) {
    list.sort((a, b) => a.charSpan[0] - b.charSpan[0]);
  }

  const orphans = explanation.vocab.filter((v) => !claimedIds.has(v.id));
  return { byChunk: buckets, orphans };
}

export function grammarForChunk(explanation: SentenceExplanation, chunkId: string): readonly GrammarPoint[] {
  return explanation.grammar.filter((g) => g.chunkIds.includes(chunkId));
}

export function orphanGrammar(explanation: SentenceExplanation): readonly GrammarPoint[] {
  return explanation.grammar.filter((g) => g.chunkIds.length === 0);
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
