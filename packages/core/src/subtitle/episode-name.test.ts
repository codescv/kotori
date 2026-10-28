import { describe, expect, it } from 'vitest';
import { parseEpisodeName, parseJapaneseNumber } from './episode-name';

describe('parseEpisodeName', () => {
  it('parses the canonical fansub layout', () => {
    const p = parseEpisodeName('[SubsPlease] Sousou no Frieren - 01 (1080p) [F02B9CEE].mkv');
    expect(p).toMatchObject({
      raw: '[SubsPlease] Sousou no Frieren - 01 (1080p) [F02B9CEE].mkv',
      title: 'Sousou no Frieren',
      episode: 1,
      releaseGroup: 'SubsPlease',
      resolution: '1080p',
      crc32: 'F02B9CEE',
      isBatch: false,
    });
    expect(p.episodeRange).toBeUndefined();
  });

  it('handles versions, decimals and titles containing " - "', () => {
    expect(parseEpisodeName('[Erai-raws] Re:Zero - Starting Life in Another World - 05v2 [720p].mkv')).toMatchObject({
      title: 'Re:Zero - Starting Life in Another World',
      episode: 5,
      version: 2,
      resolution: '720p',
      releaseGroup: 'Erai-raws',
    });
    expect(parseEpisodeName('Title - 12.5 (1080p).mp4')).toMatchObject({ title: 'Title', episode: 12.5 });
    expect(parseEpisodeName('Title 07v3.mkv')).toMatchObject({ title: 'Title', episode: 7, version: 3 });
  });

  it('parses scene-style SxxEyy names', () => {
    const p = parseEpisodeName('Spy.x.Family.2022.S01E02.1080p.WEB-DL.AAC2.0.H.264-VARYG.mkv');
    expect(p).toMatchObject({
      title: 'Spy x Family',
      season: 1,
      episode: 2,
      year: 2022,
      resolution: '1080p',
      source: 'WEB',
      audioCodec: 'AAC',
      videoCodec: 'H.264',
      releaseGroup: 'VARYG',
    });
    expect(parseEpisodeName('Title S02E11 [1080p].mkv')).toMatchObject({ title: 'Title', season: 2, episode: 11 });
  });

  it('parses Japanese 第N話 names and drops 「subtitles」', () => {
    expect(parseEpisodeName('葬送のフリーレン 第01話「冒険の終わり」.mp4')).toMatchObject({ title: '葬送のフリーレン', episode: 1 });
    expect(parseEpisodeName('ぼっち・ざ・ろっく！　第十二話.mkv')).toMatchObject({ title: 'ぼっち・ざ・ろっく！', episode: 12 });
  });

  it('detects batches with - and ~ ranges and tag-only brackets', () => {
    const a = parseEpisodeName('[Judas] Kimetsu no Yaiba 01-26 [BD 1080p HEVC FLAC].mkv');
    expect(a).toMatchObject({
      title: 'Kimetsu no Yaiba',
      episodeRange: [1, 26],
      isBatch: true,
      source: 'BD',
      resolution: '1080p',
      videoCodec: 'HEVC',
      audioCodec: 'FLAC',
      releaseGroup: 'Judas',
    });
    expect(a.episode).toBeUndefined();
    expect(parseEpisodeName('[Group] Title (01~12) [1080p]')).toMatchObject({ title: 'Title', episodeRange: [1, 12], isBatch: true });
    expect(parseEpisodeName('[Group] Title [Batch] [1080p]')).toMatchObject({ title: 'Title', isBatch: true });
    // A spaced dash between unequal widths is a title number + episode, not a batch.
    expect(parseEpisodeName('Title 2 - 10.mkv')).toMatchObject({ title: 'Title 2', episode: 10, isBatch: false });
  });

  it('parses bracket-only (Chinese fansub) layouts', () => {
    expect(parseEpisodeName('[Nekomoe kissaten][Bocchi the Rock!][05][1080p][JPSC].mp4')).toMatchObject({
      releaseGroup: 'Nekomoe kissaten',
      title: 'Bocchi the Rock!',
      episode: 5,
      resolution: '1080p',
    });
    expect(parseEpisodeName('[Sakurato] Spy x Family Season 2 [01][AVC-8bit 1080p AAC][CHS].mp4')).toMatchObject({
      title: 'Spy x Family',
      season: 2,
      episode: 1,
      videoCodec: 'AVC',
    });
  });

  it('extracts years, seasons and strips subtitle language suffixes', () => {
    expect(parseEpisodeName('Title (2024) - 03.ja.ass')).toMatchObject({ title: 'Title', year: 2024, episode: 3 });
    expect(parseEpisodeName('[Group] Title S2 - 04 [1080p].mkv')).toMatchObject({ title: 'Title', season: 2, episode: 4 });
    expect(parseEpisodeName('Title 2nd Season - 04.mkv')).toMatchObject({ title: 'Title 2nd Season', season: 2, episode: 4 });
    expect(parseEpisodeName('Movie Title (2019) [BD 2160p].mkv')).toMatchObject({ title: 'Movie Title', year: 2019, resolution: '2160p' });
  });

  it('accepts paths and never throws', () => {
    expect(parseEpisodeName('/media/anime/Title/[G] Title - 09.mkv')).toMatchObject({ title: 'Title', episode: 9 });
    expect(parseEpisodeName('C:\\anime\\Title - 10.mp4')).toMatchObject({ title: 'Title', episode: 10 });
    expect(parseEpisodeName('')).toMatchObject({ raw: '', title: '', isBatch: false });
    expect(parseEpisodeName('[[[(((')).toMatchObject({ isBatch: false });
    expect(() => parseEpisodeName(undefined as unknown as string)).not.toThrow();
  });

  it('omits absent optional fields (exactOptionalPropertyTypes)', () => {
    const p = parseEpisodeName('Just A Title.mkv');
    expect(p.title).toBe('Just A Title');
    expect(Object.keys(p).sort()).toEqual(['isBatch', 'raw', 'title']);
  });

  it('parses variety / YouTube TV recordings with full dates, 【公式】, 「Show」 and spaced # episode without misdetecting a batch', () => {
    const p = parseEpisodeName('2026-08-23_【公式】「乃木坂工事中」# 578「初耳46 前編」2026.08.23 OA_[cEE5gee6cx4].mp4');
    expect(p).toMatchObject({
      title: '乃木坂工事中',
      episode: 578,
      year: 2026,
      isBatch: false,
    });
    expect(p.episodeRange).toBeUndefined();

    const p2 = parseEpisodeName('2026-08-30_【公式】「乃木坂工事中」#579「初耳46 後編」2026.08.30 OA_[AbC_123-xYz].mp4');
    expect(p2).toMatchObject({
      title: '乃木坂工事中',
      episode: 579,
      year: 2026,
      isBatch: false,
    });
    expect(p2.episodeRange).toBeUndefined();
  });
});

describe('parseJapaneseNumber', () => {
  it('converts kanji and ASCII numerals', () => {
    expect(parseJapaneseNumber('12')).toBe(12);
    expect(parseJapaneseNumber('十二')).toBe(12);
    expect(parseJapaneseNumber('二十')).toBe(20);
    expect(parseJapaneseNumber('百五')).toBe(105);
    expect(parseJapaneseNumber('三')).toBe(3);
    expect(parseJapaneseNumber('abc')).toBeUndefined();
  });
});
