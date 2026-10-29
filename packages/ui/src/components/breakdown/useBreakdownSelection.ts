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
import type { CharSpan, Id, SemanticChunk, SentenceExplanation, VocabEntry } from '@kotori/core';
import { chunkIndexAt, findVocabAt, vocabForChunk } from '../../lib/explanation';
import { inferWordSpanAt } from './RubyText';

export interface BreakdownSelection {
  readonly activeChunkIndex: number;
  readonly activeChunk: SemanticChunk | undefined;
  /** Span painted in the sentence (`RubyText.highlight`). */
  readonly highlightSpan: CharSpan | undefined;
  /** Word-level span focused within the sentence (`RubyText.focusSpan`). */
  readonly focusWordSpan: CharSpan | undefined;
  /** Vocabulary entry directly covering `focusCharIndex`, if any. */
  readonly vocabAtFocus: VocabEntry | undefined;
  readonly linkedVocabIds: ReadonlySet<Id>;
  readonly linkedGrammarIds: ReadonlySet<Id>;
  /** Sentence click → focus that character. */
  selectChar(charIndex: number): void;
  /** Chunk card click → focus the chunk start (reverse highlight). */
  selectChunk(chunkId: Id): void;
}

const EMPTY_SELECTION: Omit<BreakdownSelection, 'selectChar' | 'selectChunk'> = {
  activeChunkIndex: -1,
  activeChunk: undefined,
  highlightSpan: undefined,
  focusWordSpan: undefined,
  vocabAtFocus: undefined,
  linkedVocabIds: new Set(),
  linkedGrammarIds: new Set(),
};

/** Non-hook core of {@link useBreakdownSelection} (exported for unit tests). */
export function deriveSelection(
  explanation: SentenceExplanation | undefined,
  focusCharIndex: number | undefined,
): Omit<BreakdownSelection, 'selectChar' | 'selectChunk'> {
  if (!explanation || focusCharIndex === undefined) {
    return EMPTY_SELECTION;
  }
  const vocabAtFocus = findVocabAt(explanation, focusCharIndex);
  const inferred = inferWordSpanAt(explanation.sentence, focusCharIndex, explanation.ruby, 0);
  let focusWordSpan: CharSpan | undefined;
  if (vocabAtFocus) {
    const inferredSlice = inferred ? explanation.sentence.slice(inferred[0], inferred[1]) : '';
    const isContiguousKatakana = inferredSlice.length > 0 && /^[\u30A1-\u30FA\u30FC-\u30FEー]+$/.test(inferredSlice);
    focusWordSpan =
      inferred && isContiguousKatakana
        ? [Math.min(vocabAtFocus.charSpan[0], inferred[0]), Math.max(vocabAtFocus.charSpan[1], inferred[1])]
        : vocabAtFocus.charSpan;
  } else {
    focusWordSpan = inferred;
  }

  const idx = chunkIndexAt(explanation, focusCharIndex);
  const chunk = idx >= 0 ? explanation.chunks[idx] : undefined;
  if (!chunk) {
    return { ...EMPTY_SELECTION, focusWordSpan, vocabAtFocus };
  }
  return {
    activeChunkIndex: idx,
    activeChunk: chunk,
    highlightSpan: chunk.charSpan,
    focusWordSpan,
    vocabAtFocus,
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
