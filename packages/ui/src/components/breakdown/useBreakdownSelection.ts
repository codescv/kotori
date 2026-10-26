/**
 * charIndex ⇄ chunk two-way sync for the breakdown panel (ARCHITECTURE §6.2).
 *
 * Pure derived state: given the explanation and the focused UTF-16 index it
 * resolves the active chunk (`chunkIndexAt`, gaps → nearest right/left), its
 * highlight span, and the vocab / grammar items linked to that chunk. Clicking
 * a chunk card focuses `chunk.charSpan[0]` (reverse highlight). No host calls,
 * so switching characters within the same sentence is 0-latency.
 */
import { useCallback, useMemo } from 'react';
import type { CharSpan, Id, SemanticChunk, SentenceExplanation } from '@kotori/core';
import { chunkIndexAt, vocabForChunk } from '../../lib/explanation';

export interface BreakdownSelection {
  readonly activeChunkIndex: number;
  readonly activeChunk: SemanticChunk | undefined;
  /** Span painted in the sentence (`RubyText.highlight`). */
  readonly highlightSpan: CharSpan | undefined;
  readonly linkedVocabIds: ReadonlySet<Id>;
  readonly linkedGrammarIds: ReadonlySet<Id>;
  /** Sentence click → focus that character. */
  selectChar(charIndex: number): void;
  /** Chunk card click → focus the chunk start (reverse highlight). */
  selectChunk(chunkId: Id): void;
}

/** Non-hook core of {@link useBreakdownSelection} (exported for unit tests). */
export function deriveSelection(
  explanation: SentenceExplanation | undefined,
  focusCharIndex: number | undefined,
): Omit<BreakdownSelection, 'selectChar' | 'selectChunk'> {
  if (!explanation || focusCharIndex === undefined) {
    return { activeChunkIndex: -1, activeChunk: undefined, highlightSpan: undefined, linkedVocabIds: new Set(), linkedGrammarIds: new Set() };
  }
  const idx = chunkIndexAt(explanation, focusCharIndex);
  const chunk = idx >= 0 ? explanation.chunks[idx] : undefined;
  if (!chunk) {
    return { activeChunkIndex: -1, activeChunk: undefined, highlightSpan: undefined, linkedVocabIds: new Set(), linkedGrammarIds: new Set() };
  }
  return {
    activeChunkIndex: idx,
    activeChunk: chunk,
    highlightSpan: chunk.charSpan,
    linkedVocabIds: new Set(vocabForChunk(explanation, chunk).map((v) => v.id)),
    linkedGrammarIds: new Set(explanation.grammar.filter((g) => g.chunkIds.includes(chunk.id)).map((g) => g.id)),
  };
}

export function useBreakdownSelection(
  explanation: SentenceExplanation | undefined,
  focusCharIndex: number | undefined,
  onFocusChange: (charIndex: number) => void,
): BreakdownSelection {
  const derived = useMemo(() => deriveSelection(explanation, focusCharIndex), [explanation, focusCharIndex]);
  const selectChar = useCallback((i: number) => onFocusChange(i), [onFocusChange]);
  const selectChunk = useCallback(
    (chunkId: Id) => {
      const chunk = explanation?.chunks.find((c) => c.id === chunkId);
      if (chunk && chunk.charSpan[1] > chunk.charSpan[0]) onFocusChange(chunk.charSpan[0]);
    },
    [explanation, onFocusChange],
  );
  return { ...derived, selectChar, selectChunk };
}
