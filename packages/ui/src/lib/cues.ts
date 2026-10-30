/**
 * Subtitle helpers for the UI — re-exported from `@kotori/core/subtitle` so the
 * overlay, transcript and breakdown use exactly the same merge / offset
 * semantics as the hosts (ARCHITECTURE §4.2).
 */
import {
  activeCueIndexes,
  buildSubtitleContext,
  buildTranscriptRows,
  cueIndexAt,
  cueOffsetToSentenceIndex,
  dropDuplicateLines,
  formatClock,
  graphemeCount,
  isBilingualTrack,
  isSignCue,
  matchSecondaryCuesToRows,
  mergeCuesToSentence,
  mergePerCharacterCueGroups,
  nextCueIndex,
  normalizeLanguageTag,
  parseEpisodeName,
  prevCueIndex,
  sentenceIndexToCueOffset,
  splitBilingualCueText,
  translationTextOf,
  type AnimeEpisode,
  type AnimeSeries,
  type MergedSentence,
  type SubtitleContextRow,
  type SubtitleCue,
  type TranscriptOptions,
} from '@kotori/core';

export {
  activeCueIndexes,
  buildSubtitleContext,
  buildTranscriptRows,
  cueIndexAt,
  cueOffsetToSentenceIndex,
  dropDuplicateLines,
  formatClock,
  graphemeCount,
  isBilingualTrack,
  isSignCue,
  matchSecondaryCuesToRows,
  mergeCuesToSentence,
  mergePerCharacterCueGroups,
  nextCueIndex,
  normalizeLanguageTag,
  prevCueIndex,
  sentenceIndexToCueOffset,
  splitBilingualCueText,
  translationTextOf,
  type MergedSentence,
  type SubtitleContextRow,
  type TranscriptOptions,
};

/** Context window shared by single-click explain and batch pre-explain (same prompt ⇒ same cache key). */
export const SUBTITLE_CONTEXT_BEFORE = 3;
export const SUBTITLE_CONTEXT_AFTER = 2;

/** Displayable ASS speaker (`Name` field) of a cue; `Default` / empty → `undefined`. */
export function cueActor(cue: Pick<SubtitleCue, 'markup'>): string | undefined {
  const actor = cue.markup?.actor?.trim();
  return actor && actor.toLowerCase() !== 'default' ? actor : undefined;
}

/** Japanese part of a cue (bilingual fansub translation lines stripped) — what is sent to Gemini. */
export function cueJapaneseText(cue: Pick<SubtitleCue, 'text'>): string {
  return splitBilingualCueText(cue.text).primaryJa;
}

/** Context rows (Japanese text + speaker) for {@link subtitleExplainContext}. */
export function toSubtitleContextRows(cues: readonly SubtitleCue[]): SubtitleContextRow[] {
  return cues.map((c) => {
    const actor = cueActor(c);
    return actor ? { text: cueJapaneseText(c), actor } : { text: cueJapaneseText(c) };
  });
}

/**
 * Explain-request context for rows `[first, last]` via core `buildSubtitleContext`.
 * Empty arrays are omitted so the request (and cache key) is identical wherever
 * it is built. `speaker` is only set for a single row.
 */
export function subtitleExplainContext(
  rows: readonly SubtitleContextRow[],
  first: number,
  last: number = first,
): { contextBefore?: readonly string[]; contextAfter?: readonly string[]; speaker?: string } {
  if (first < 0 || last < 0) return {};
  const before = buildSubtitleContext(rows, first, SUBTITLE_CONTEXT_BEFORE, SUBTITLE_CONTEXT_AFTER).contextBefore;
  const after = buildSubtitleContext(rows, last, SUBTITLE_CONTEXT_BEFORE, SUBTITLE_CONTEXT_AFTER);
  const speaker = first === last ? after.speaker : undefined;
  return {
    ...(before.length > 0 ? { contextBefore: before } : {}),
    ...(after.contextAfter.length > 0 ? { contextAfter: after.contextAfter } : {}),
    ...(speaker ? { speaker } : {}),
  };
}

/** Check whether a string looks like an uncleaned video/archive release filename. */
export function isRawMediaFileName(name: string): boolean {
  return (
    /^\s*\[[^\]]+\]/.test(name) ||
    /\b(?:1080p|720p|2160p|480p|BDRip|WEBRip|WEB-DL|BluRay|HEVC|x264|x265|10bit|AAC|FLAC)\b/i.test(name) ||
    /\[[0-9A-Fa-f]{8}\]/.test(name) ||
    /\.(?:mkv|mp4|webm|avi|cbz|zip|mokuro)$/i.test(name)
  );
}

/**
 * Prioritize the anime work/series title (`作品名称`) over raw folder or release filenames.
 */
export function formatAnimeSeriesTitle(
  series: Pick<AnimeSeries, 'title'> | undefined,
  meta?: {
    readonly nativeTitle?: string | undefined;
    readonly chineseTitle?: string | undefined;
    readonly romajiTitle?: string | undefined;
  },
): string {
  if (!series) return meta?.nativeTitle ?? meta?.chineseTitle ?? meta?.romajiTitle ?? '';
  const raw = series.title.trim();
  if (!isRawMediaFileName(raw)) {
    return raw;
  }
  const parsed = parseEpisodeName(raw).title.trim();
  return meta?.nativeTitle ?? meta?.chineseTitle ?? (parsed || raw);
}

/**
 * Prioritize clean episode title (`第X話` or work title + episode) over raw video filename stems.
 */
export function formatAnimeEpisodeTitle(
  episode: Pick<AnimeEpisode, 'title' | 'fileName' | 'parsedName'>,
  seriesTitle?: string,
): string {
  const epNum = episode.parsedName.episode;
  const rawTitle = episode.title.trim();
  const fileStem = episode.fileName.replace(/\.[^.]+$/, '').trim();
  const isRaw = rawTitle === fileStem || isRawMediaFileName(rawTitle);
  if (isRaw) {
    if (epNum !== undefined) return `第${epNum}話`;
    const cleanWork = seriesTitle?.trim() || episode.parsedName.title.trim();
    if (cleanWork) return cleanWork;
  }
  return rawTitle;
}
