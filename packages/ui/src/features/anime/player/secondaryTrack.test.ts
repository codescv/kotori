import { describe, expect, it } from 'vitest';
import type { AnimeEpisode, SubtitleTrack } from '@kotori/core';
import {
  DEFAULT_SECONDARY_LANGS,
  pickDefaultSecondaryTrack,
  resolveSecondaryTrackId,
  trackLanguage,
} from './secondaryTrack';

function makeTrack(id: string, over: Partial<SubtitleTrack> = {}): SubtitleTrack {
  return {
    id,
    episodeId: 'ep-1',
    origin: 'external',
    format: 'srt',
    label: id,
    filePath: `/subs/${id}.srt`,
    isDefault: false,
    delayMs: 0,
    ...over,
  };
}

function makeEpisode(subtitleTracks: readonly SubtitleTrack[]): AnimeEpisode {
  return {
    id: 'ep-1',
    seriesId: 's-1',
    title: '第1話',
    fileName: 'Show - 01.mkv',
    filePath: '/anime/Show - 01.mkv',
    container: 'mkv',
    sizeBytes: 1000,
    parsedName: { raw: 'Show - 01.mkv', title: 'Show', episode: 1, isBatch: false },
    subtitleTracks,
    mediaUrl: 'mock://media/ep-1',
  };
}

describe('secondaryTrack', () => {
  it('normalises track language tags and falls back to label filename detection', () => {
    expect(trackLanguage(makeTrack('t1', { language: 'jpn' }))).toBe('ja');
    expect(trackLanguage(makeTrack('t2', { language: 'chs' }))).toBe('zh-CN');
    expect(trackLanguage(makeTrack('t3', { language: 'zh-hant' }))).toBe('zh-TW');
    expect(trackLanguage(makeTrack('t4', { language: 'eng' }))).toBe('en');
    expect(trackLanguage(makeTrack('t5', { label: 'Show.01.简体中文.ass' }))).toBe('zh-CN');
    expect(trackLanguage(makeTrack('t6', { label: 'Mystery Track' }))).toBeUndefined();
  });

  it('pickDefaultSecondaryTrack prefers zh-CN over en, skips primary id/lang and unextracted embedded tracks', () => {
    const ja = makeTrack('ja-1', { language: 'ja', isDefault: true });
    const ja2 = makeTrack('ja-2', { language: 'ja' });
    const en = makeTrack('en-1', { language: 'en' });
    const zh = makeTrack('zh-1', { language: 'zh-CN' });
    const embUnextracted: SubtitleTrack = {
      id: 'emb-zh',
      episodeId: 'ep-1',
      origin: 'embedded',
      format: 'ass',
      label: 'Embedded CHS',
      language: 'zh-CN',
      streamIndex: 2,
      isDefault: false,
      delayMs: 0,
    };

    // Picks zh-CN over en regardless of track order in episode
    const epBoth = makeEpisode([ja, en, zh]);
    expect(pickDefaultSecondaryTrack(epBoth, 'ja-1', DEFAULT_SECONDARY_LANGS)?.id).toBe('zh-1');
    expect(pickDefaultSecondaryTrack(epBoth, 'ja-1', ['en', 'zh-CN'])?.id).toBe('en-1');

    // Skips unextracted embedded zh-CN and falls through to playable en
    const epEmb = makeEpisode([ja, embUnextracted, en]);
    expect(pickDefaultSecondaryTrack(epEmb, 'ja-1', DEFAULT_SECONDARY_LANGS)?.id).toBe('en-1');

    // Extracted embedded track (with filePath) IS eligible
    const embExtracted: SubtitleTrack = { ...embUnextracted, filePath: '/extracted/stream2.ass' };
    expect(pickDefaultSecondaryTrack(makeEpisode([ja, embExtracted, en]), 'ja-1', DEFAULT_SECONDARY_LANGS)?.id).toBe('emb-zh');

    // Never picks same language as primary or falls back to arbitrary playable track
    const epJaOnly = makeEpisode([ja, ja2]);
    expect(pickDefaultSecondaryTrack(epJaOnly, 'ja-1', ['ja', ...DEFAULT_SECONDARY_LANGS])).toBeUndefined();
    expect(pickDefaultSecondaryTrack(makeEpisode([ja, makeTrack('ko-1', { language: 'ko' })]), 'ja-1', DEFAULT_SECONDARY_LANGS)).toBeUndefined();
  });

  it('resolveSecondaryTrackId handles auto/off/track choices, loading tri-state, bilingual guard, same-track guard, and pre-reload missing id', () => {
    const ja = makeTrack('ja-1', { language: 'ja', isDefault: true });
    const zh = makeTrack('zh-1', { language: 'zh-CN' });
    const emb: SubtitleTrack = {
      id: 'emb-1',
      episodeId: 'ep-1',
      origin: 'embedded',
      format: 'ass',
      label: 'Embedded #2',
      language: 'zh-CN',
      streamIndex: 2,
      isDefault: false,
      delayMs: 0,
    };
    const ep = makeEpisode([ja, zh, emb]);

    // Auto mode: waits while primaryIsBilingual is undefined (loading)
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'auto' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'auto', primaryIsBilingual: undefined }),
    ).toBeUndefined();

    // Auto mode: suppressed when primary is bilingual
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'auto' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'auto', primaryIsBilingual: true }),
    ).toBeUndefined();

    // Auto mode: suppressed when global setting mode is 'off'
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'auto' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'off', primaryIsBilingual: false }),
    ).toBeUndefined();

    // Auto mode: resolves zh-1 when primary is monolingual
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'auto' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'auto', primaryIsBilingual: false }),
    ).toBe('zh-1');

    // Session 'off' overrides global 'auto'
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'off' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'auto', primaryIsBilingual: false }),
    ).toBeUndefined();

    // Manual 'track' overrides global 'off' and primaryIsBilingual, but still enforces same-track, existence, and extracted guards
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'track', id: 'zh-1' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'off', primaryIsBilingual: true }),
    ).toBe('zh-1');
    expect(
      resolveSecondaryTrackId(ep, 'zh-1', { kind: 'track', id: 'zh-1' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'auto', primaryIsBilingual: false }),
    ).toBeUndefined();
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'track', id: 'not-reloaded-yet' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'auto', primaryIsBilingual: false }),
    ).toBeUndefined();
    expect(
      resolveSecondaryTrackId(ep, 'ja-1', { kind: 'track', id: 'emb-1' }, { preferred: DEFAULT_SECONDARY_LANGS, mode: 'auto', primaryIsBilingual: false }),
    ).toBeUndefined();
  });
});
