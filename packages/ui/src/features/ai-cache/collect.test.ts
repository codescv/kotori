import { describe, expect, it, vi } from 'vitest';
import type { AnimeEpisode, MangaPage, MangaPageGuideResult, SubtitleCue, SubtitleTrack, TranscriptRow } from '@kotori/core';
import { buildTranscriptRows, cueJapaneseText, subtitleExplainContext, toSubtitleContextRows } from '../../lib/cues';
import { blockContext } from '../manga/reader/BlockOverlay';
import { collectGuideBubbleRequests, collectMangaBlockRequests, collectSubtitleRequests, dedupeBySentence, isExplainableJapaneseText } from './collect';
import { isJapaneseTrack, pickCacheTrack, resolveCacheTrack } from './tracks';

const cue = (index: number, text: string, extra: Partial<SubtitleCue> = {}): SubtitleCue => ({ index, startMs: index * 1000, endMs: index * 1000 + 900, text, ...extra }) as SubtitleCue;

describe('isExplainableJapaneseText', () => {
  it('keeps short real Japanese lines and drops music / punctuation-only lines', () => {
    for (const ok of ['なんで？', 'まじで？', '行くぞ！', '（ため息）はぁ', '空がこんなに青い', '猫だ']) expect(isExplainableJapaneseText(ok), ok).toBe(true);
    for (const no of ['', '猫', '♪～', '……', 'ーー', '♪', '！？', 'OK!', '   ']) expect(isExplainableJapaneseText(no), no).toBe(false);
  });
});

describe('collectSubtitleRequests (100 % parity with useSubtitleBreakdown.openCue)', () => {
  it('builds the same sentence / context / source a click would, for every explainable row', () => {
    const cues = [cue(0, 'おはよう！'), cue(1, '♪～'), cue(2, 'なんで？', { markup: { actor: '湊' } } as Partial<SubtitleCue>), cue(3, '行くぞ！\nLet’s go!'), cue(4, 'まだ話は終わってない')];
    const rows: TranscriptRow[] = buildTranscriptRows(cues, { mergeKaraoke: true, hideSigns: true });
    const reqs = collectSubtitleRequests({ rows, episodeId: 'ep', trackId: 'tr', targetLanguage: 'zh-CN', sceneHint: 'Kotori' });
    expect(reqs.map((r) => r.sentence)).toEqual(['おはよう！', 'なんで？', '行くぞ！', 'まだ話は終わってない']);
    // What `openCue` sends for row 2 (context from all row cues, Japanese part only).
    const rowCues = rows.map((r) => r.cue);
    const i = rowCues.findIndex((c) => c.index === 2);
    const expected = { sentence: cueJapaneseText(rowCues[i]!), sceneHint: 'Kotori', ...subtitleExplainContext(toSubtitleContextRows(rowCues), i) };
    expect(reqs[1]).toMatchObject(expected);
    expect(reqs[1]?.speaker).toBe('湊');
    expect(reqs[1]?.source).toEqual({ kind: 'subtitle', episodeId: 'ep', trackId: 'tr', cueIndexes: [2], cueCharSpans: [[0, 4]], startMs: 2000, endMs: 2900 });
  });
});

describe('manga collection', () => {
  const page = (index: number, texts: readonly string[]): MangaPage =>
    ({
      index,
      relativePath: `p${index}.jpg`,
      width: 1000,
      height: 1400,
      imageUrl: `p${index}.jpg`,
      blocks: texts.map((text, i) => ({ index: i, text, lines: [text], vertical: true, rect: { left: 800 - i * 300, top: 100, right: 900 - i * 300, bottom: 400 }, fontSize: 20, zIndex: i })),
    }) as unknown as MangaPage;

  it('collects .mokuro bubbles in RTL reading order with blockContext + series sceneHint', () => {
    const p = page(3, ['右の吹き出し', '……', '左の吹き出しだよ']);
    const reqs = collectMangaBlockRequests({ volumeId: 'v', pages: [p], targetLanguage: 'zh-CN', sceneHint: '放課後ノート' });
    expect(reqs.map((r) => r.sentence)).toEqual(['右の吹き出し', '左の吹き出しだよ']);
    expect(reqs[1]).toMatchObject({ source: { kind: 'manga', volumeId: 'v', pageIndex: 3, blockIndex: 2 }, sceneHint: '放課後ノート', ...blockContext(p, 2) });
  });

  it('collects raw-page guide bubbles like Reader.pickGuideBubble (guide neighbours as context, speaker)', () => {
    const p = page(0, []);
    const guide = {
      volumeId: 'v',
      pageIndex: 0,
      summary: '',
      model: 'm',
      createdAt: 0,
      bubbles: [
        { order: 2, text: 'ことり、待って！', speaker: '湊', translation: '', rectFraction: { left: 0, top: 0, right: 1, bottom: 1 } },
        { order: 1, text: 'おはよう', translation: '', rectFraction: { left: 0, top: 0, right: 1, bottom: 1 } },
        { order: 3, text: '♪', translation: '', rectFraction: { left: 0, top: 0, right: 1, bottom: 1 } },
      ],
    } as MangaPageGuideResult;
    const reqs = collectGuideBubbleRequests({ volumeId: 'v', page: p, guide, targetLanguage: 'en', sceneHint: '星屑ラジオ' });
    expect(reqs.map((r) => r.sentence)).toEqual(['おはよう', 'ことり、待って！']);
    expect(reqs[1]).toMatchObject({ speaker: '湊', contextBefore: ['おはよう'], contextAfter: ['♪'], targetLanguage: 'en', source: { kind: 'manga', volumeId: 'v', pageIndex: 0 } });
  });
});

describe('dedupeBySentence', () => {
  it('keeps first-occurrence order and the richest context per (sentence, targetLanguage)', () => {
    const base = { source: { kind: 'manual' as const } };
    const out = dedupeBySentence([
      { ...base, sentence: 'A', targetLanguage: 'zh-CN' },
      { ...base, sentence: 'B', targetLanguage: 'zh-CN' },
      { ...base, sentence: 'A', targetLanguage: 'zh-CN', contextBefore: ['x'] },
      { ...base, sentence: 'A', targetLanguage: 'en' },
    ]);
    expect(out.map((r) => `${r.sentence}/${r.targetLanguage}`)).toEqual(['A/zh-CN', 'B/zh-CN', 'A/en']);
    expect(out[0]?.contextBefore).toEqual(['x']);
  });
});

describe('cache track resolution', () => {
  const track = (id: string, extra: Partial<SubtitleTrack>): SubtitleTrack => ({ id, episodeId: 'ep', origin: 'external', format: 'ass', label: id, isDefault: false, delayMs: 0, filePath: `/${id}`, ...extra });
  const episode = (tracks: SubtitleTrack[]): AnimeEpisode => ({ id: 'ep', seriesId: 's', subtitleTracks: tracks }) as unknown as AnimeEpisode;

  it('prefers the requested track, then a Japanese one, never a Chinese-only track', () => {
    const zh = track('zh', { language: 'zh-CN', isDefault: true });
    const ja = track('ja', { language: 'ja' });
    expect(pickCacheTrack(episode([zh, ja]), undefined, ['ja'])?.id).toBe('ja');
    expect(pickCacheTrack(episode([zh, ja]), 'zh', ['ja'])?.id).toBe('zh');
    expect(pickCacheTrack(episode([zh]), undefined, ['ja'])).toBeUndefined();
    expect(isJapaneseTrack({ label: '日本語 (ASS)' })).toBe(true);
    expect(isJapaneseTrack({ language: 'jpn', label: 'x' })).toBe(true);
  });

  it('extracts an embedded Japanese stream when that is all the video has, and fails clearly without subtitles', async () => {
    const emb = track('emb', { origin: 'embedded', language: 'ja', streamIndex: 2, filePath: undefined as unknown as string });
    const extracted = track('emb-x', { origin: 'external', language: 'ja' });
    const extractEmbeddedTrack = vi.fn(async () => extracted);
    const host = { anime: { extractEmbeddedTrack } } as unknown as Parameters<typeof resolveCacheTrack>[0];
    const { filePath: _f, ...embNoPath } = emb;
    expect((await resolveCacheTrack(host, episode([embNoPath as SubtitleTrack]), undefined, ['ja'])).id).toBe('emb-x');
    expect(extractEmbeddedTrack).toHaveBeenCalledWith('ep', 2);
    await expect(resolveCacheTrack(host, episode([]), undefined, ['ja'])).rejects.toMatchObject({ code: 'not-found' });
  });
});
