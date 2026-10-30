/**
 * Pure secondary-subtitle (副字幕) track selection and resolution.
 *
 * Separating user intent (`SecondaryChoice`) from the resolved `secondaryTrackId`
 * gives us the same-track guard (`candidate === primaryId` → `undefined`),
 * race-free embedded extraction (`{ kind: 'track', id }` resolves once
 * `reloadEpisode()` delivers the extracted track), and tri-state loading guard
 * (`primaryIsBilingual === undefined` holds off auto-selection while primary
 * cues are still loading).
 */
import {
  detectSubtitleLanguageFromName,
  normalizeLanguageTag,
  type AnimeEpisode,
  type LanguageTag,
  type SubtitleTrack,
} from '@kotori/core';

/** User intent for 副字幕. `auto` is the initial value for every episode. */
export type SecondaryChoice =
  | { readonly kind: 'auto' }
  | { readonly kind: 'off' }
  | { readonly kind: 'track'; readonly id: string };

export const DEFAULT_SECONDARY_LANGS: readonly LanguageTag[] = ['zh-CN', 'zh', 'zh-TW', 'en'];

export function trackLanguage(track: SubtitleTrack): LanguageTag | undefined {
  return normalizeLanguageTag(track.language) ?? detectSubtitleLanguageFromName(track.label);
}

/** Auto 副字幕: first playable, non-primary track whose language is in `preferred` (in preference order). */
export function pickDefaultSecondaryTrack(
  episode: AnimeEpisode,
  primaryId: string | undefined,
  preferred: readonly LanguageTag[],
): SubtitleTrack | undefined {
  const primary = episode.subtitleTracks.find((t) => t.id === primaryId);
  const primaryLang = primary ? trackLanguage(primary) : undefined;
  const playable = episode.subtitleTracks.filter(
    (t) => t.id !== primaryId && (t.origin !== 'embedded' || Boolean(t.filePath)),
  );
  for (const lang of preferred) {
    const hit = playable.find((t) => trackLanguage(t) === lang && lang !== primaryLang);
    if (hit) return hit;
  }
  return undefined;
}

export function resolveSecondaryTrackId(
  episode: AnimeEpisode,
  primaryId: string | undefined,
  choice: SecondaryChoice,
  opts: {
    readonly preferred: readonly LanguageTag[];
    readonly mode: 'auto' | 'off';
    readonly primaryIsBilingual: boolean | undefined;
  },
): string | undefined {
  let id: string | undefined;
  if (choice.kind === 'track') {
    id = episode.subtitleTracks.some((t) => t.id === choice.id) ? choice.id : undefined;
  } else if (choice.kind === 'auto') {
    if (opts.mode !== 'auto' || opts.primaryIsBilingual !== false) return undefined;
    id = pickDefaultSecondaryTrack(episode, primaryId, opts.preferred)?.id;
  }
  if (id !== undefined && id === primaryId) return undefined;
  const t = episode.subtitleTracks.find((x) => x.id === id);
  return t && (t.origin !== 'embedded' || Boolean(t.filePath)) ? id : undefined;
}
