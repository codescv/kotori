/**
 * Subtitle helpers for the UI — re-exported from `@kotori/core/subtitle` so the
 * overlay, transcript and breakdown use exactly the same merge / offset
 * semantics as the hosts (ARCHITECTURE §4.2).
 */
import {
  activeCueIndexes,
  buildTranscriptRows,
  cueIndexAt,
  cueOffsetToSentenceIndex,
  formatClock,
  graphemeCount,
  mergeCuesToSentence,
  mergePerCharacterCueGroups,
  nextCueIndex,
  parseEpisodeName,
  prevCueIndex,
  sentenceIndexToCueOffset,
  type AnimeEpisode,
  type AnimeSeries,
  type MergedSentence,
  type TranscriptOptions,
} from '@kotori/core';

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
};

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
  if (meta?.nativeTitle && (isRawMediaFileName(raw) || /^[\x20-\x7E]+$/.test(raw))) {
    return meta.nativeTitle;
  }
  if (isRawMediaFileName(raw)) {
    const parsed = parseEpisodeName(raw).title.trim();
    if (parsed) return meta?.nativeTitle ?? meta?.chineseTitle ?? parsed;
  }
  return raw;
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
