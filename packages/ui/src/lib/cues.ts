/**
 * Subtitle helpers for the UI — re-exported from `@kotori/core/subtitle` so the
 * overlay, transcript and breakdown use exactly the same merge / offset
 * semantics as the hosts (ARCHITECTURE §4.2).
 */
export {
  activeCueIndexes,
  buildTranscriptRows,
  cueIndexAt,
  cueOffsetToSentenceIndex,
  formatClock,
  graphemeCount,
  mergeCuesToSentence,
  mergePerCharacterCueGroups,
  nextCueIndex,
  prevCueIndex,
  sentenceIndexToCueOffset,
  type MergedSentence,
  type TranscriptOptions,
} from '@kotori/core';
