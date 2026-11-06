/** Pick (or extract) the Japanese subtitle track a whole-episode 「缓存AI解读」 job reads. */
import { KotoriError, type AnimeEpisode, type PlatformHost, type SubtitleTrack } from '@kotori/core';

const JA_LANG_RE = /^(ja|jpn|jp)(?:[-_].*)?$/i;
const JA_LABEL_RE = /日本語|japanese|\bjpn\b|\bja\b|\[ja\]|\.ja\./i;

/** Japanese track by language tag or label. */
export function isJapaneseTrack(track: Pick<SubtitleTrack, 'language' | 'label'>): boolean {
  if (track.language) return JA_LANG_RE.test(track.language);
  return JA_LABEL_RE.test(track.label);
}

const playable = (t: SubtitleTrack): boolean => t.origin !== 'embedded' || Boolean(t.filePath);

/**
 * Track choice without side effects: the requested (player-selected) track,
 * else a playable Japanese track (default first), else the player's default
 * pick (explicit default → preferred language → first playable).
 * `undefined` when nothing playable exists.
 */
export function pickCacheTrack(episode: AnimeEpisode, requestedTrackId: string | undefined, preferred: readonly string[]): SubtitleTrack | undefined {
  const tracks = episode.subtitleTracks.filter(playable);
  const requested = requestedTrackId ? tracks.find((t) => t.id === requestedTrackId) : undefined;
  if (requested) return requested;
  const ja = tracks.filter(isJapaneseTrack);
  return (
    ja.find((t) => t.isDefault) ??
    ja[0] ??
    tracks.find((t) => t.isDefault && !t.language) ??
    preferred.map((lang) => tracks.find((t) => t.language === lang)).find(Boolean) ??
    tracks.find((t) => !t.language)
  );
}

/**
 * Resolve the track to cache, extracting an embedded Japanese stream when
 * that is all the episode has. Throws `not-found` when the video has no
 * usable (Japanese) subtitles.
 */
export async function resolveCacheTrack(
  host: Pick<PlatformHost, 'anime'>,
  episode: AnimeEpisode,
  requestedTrackId: string | undefined,
  preferred: readonly string[],
): Promise<SubtitleTrack> {
  const picked = pickCacheTrack(episode, requestedTrackId, preferred);
  if (picked) return picked;
  const embedded = episode.subtitleTracks.filter((t) => t.origin === 'embedded' && !t.filePath && t.streamIndex !== undefined);
  const embeddedJa = embedded.find(isJapaneseTrack) ?? embedded.find((t) => !t.language);
  if (embeddedJa && embeddedJa.streamIndex !== undefined) {
    return host.anime.extractEmbeddedTrack(episode.id, embeddedJa.streamIndex);
  }
  throw new KotoriError('not-found', 'no-japanese-subtitles');
}
