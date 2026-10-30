import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../types';
import { parseAss } from './ass';
import { readFixtureText } from './fixtures.testutil';
import * as subtitleEntry from './index';
import * as coreEntry from '../index';
import { buildTranscriptRows, DEFAULT_CHAIN_FOLD_GAP_MS, isSignCue, matchSecondaryCuesToRows } from './transcript';

const fixtureCues = (): readonly SubtitleCue[] => parseAss(readFixtureText('karaoke-per-char.ass')).cues;

/** Compact row view: [rep, text, rawIndexes, chainEndMs]. */
const view = (rows: ReturnType<typeof buildTranscriptRows>): Array<[number, string, readonly number[], number]> =>
  rows.map((r) => [r.rep, r.cue.text, r.rawIndexes, r.chainEndMs]);

/** Plain cue helper; `index` = position. */
const cue = (index: number, text: string, startMs: number, endMs: number): SubtitleCue => ({ index, startMs, endMs, text, rawText: text });

describe('buildTranscriptRows', () => {
  it('merges karaoke, de-dups, chain-folds and hides signs (fixture)', () => {
    expect(view(buildTranscriptRows(fixtureCues(), { mergeKaraoke: true, hideSigns: true }))).toEqual([
      [1, 'こんにちは、\n世界！', [1], 3500], // the Comment twin is hidden and does not shadow it
      [4, 'これはテスト です', [4, 5], 8000], // duplicate layer folded
      [6, '手紙', [6], 9500],
      [7, '手を伸ばして', [7, 8, 9, 10, 11, 12], 13000],
      [13, '空へ届け', [13, 14, 15, 16], 15620],
      [17, 'Well, then — top', [17], 18000],
      [18, 'ラララ', [18, 19], 23000], // adjacency chain (gap 0)
      [20, 'はい', [20], 25500], // separated by silence → separate rows
      [21, 'はい', [21], 27500],
    ]);
  });

  it('keeps signs, comments and drawings when hideSigns is off', () => {
    const rows = view(buildTranscriptRows(fixtureCues(), { mergeKaraoke: true, hideSigns: false }));
    expect(rows.slice(0, 3)).toEqual([
      [0, 'こんにちは、\n世界！', [0, 1], 3500],
      [2, '看板', [2], 6000],
      [3, '', [3], 6000],
    ]);
    expect(rows).toHaveLength(11);
  });

  it('lists per-char events individually when mergeKaraoke is off', () => {
    const rows = buildTranscriptRows(fixtureCues(), { mergeKaraoke: false, hideSigns: true });
    expect(rows).toHaveLength(17);
    expect(rows.slice(3, 5).map((r) => r.cue.text)).toEqual(['手', 'を']);
  });

  it('chain-folds within the gap only, per text, and remaps raw indexes to the chain head', () => {
    const cues = [
      cue(0, 'ラ', 0, 1000),
      cue(1, '訳', 500, 1500), // different text interleaves without breaking the ラ chain
      cue(2, 'ラ', 1000 + DEFAULT_CHAIN_FOLD_GAP_MS, 2000), // exactly at the gap → folds
      cue(3, 'ラ', 2000, 3000), // duplicate key of nothing; continues chain
      cue(4, 'ラ', 2000, 3000), // exact (startMs, text) duplicate of 3
      cue(5, 'ラ', 3000 + DEFAULT_CHAIN_FOLD_GAP_MS + 1, 4000), // 41 ms gap → new chain
    ];
    expect(view(buildTranscriptRows(cues, { mergeKaraoke: true, hideSigns: true }))).toEqual([
      [0, 'ラ', [0, 2, 3, 4], 3000],
      [1, '訳', [1], 1500],
      [5, 'ラ', [5], 4000],
    ]);
    expect(buildTranscriptRows(cues, { mergeKaraoke: true, hideSigns: true, chainFoldGapMs: 0 })).toHaveLength(4);
  });

  it('chain-folds merged karaoke groups by their merged text', () => {
    const { cues } = parseAss(
      [
        '[Script Info]',
        'PlayResX: 1280',
        'PlayResY: 720',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:02.00,OP,,0,0,0,,{\\pos(100,600)}夢',
        'Dialogue: 0,0:00:01.00,0:00:02.00,OP,,0,0,0,,{\\pos(130,600)}を',
        'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,夢を',
        'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,夢を',
      ].join('\n'),
    );
    expect(view(buildTranscriptRows(cues, { mergeKaraoke: true, hideSigns: true }))).toEqual([
      [0, '夢を', [0, 1, 2], 3000],
      [3, '夢を', [3], 6000],
    ]);
  });
});

describe('isSignCue & matchSecondaryCuesToRows', () => {
  it('re-exports secondary subtitle helpers from both @kotori/core/subtitle and @kotori/core', () => {
    for (const mod of [subtitleEntry, coreEntry]) {
      expect(typeof mod.normalizeLanguageTag).toBe('function');
      expect(typeof mod.translationTextOf).toBe('function');
      expect(typeof mod.dropDuplicateLines).toBe('function');
      expect(typeof mod.isBilingualTrack).toBe('function');
      expect(typeof mod.isSignCue).toBe('function');
      expect(typeof mod.matchSecondaryCuesToRows).toBe('function');
    }
  });

  it('isSignCue flags empty text, drawings, \\move signs and comments', () => {
    const baseMarkup = { layer: 0, hasMove: false, hasKaraoke: false, isDrawing: false, isComment: false, playResX: 1280, playResY: 720 };
    expect(isSignCue(cue(0, '   ', 0, 1000))).toBe(true);
    expect(isSignCue({ ...cue(1, 'm 0 0 l 10 10', 0, 1000), markup: { ...baseMarkup, isDrawing: true } })).toBe(true);
    expect(isSignCue({ ...cue(2, '看板', 0, 1000), markup: { ...baseMarkup, hasMove: true } })).toBe(true);
    expect(isSignCue({ ...cue(3, 'メモ', 0, 1000), markup: { ...baseMarkup, isComment: true } })).toBe(true);
    expect(isSignCue({ ...cue(4, 'おはよう', 0, 1000), markup: baseMarkup })).toBe(false);
  });

  it('matches exact overlaps, concatenates 1-to-2 chain-folded cues, deduplicates repeats, and excludes near-misses and signs', () => {
    const primary = [
      cue(0, 'おはよう、ことり。今日も早いね。', 1000, 3000),
      cue(1, 'ラララ', 4000, 6000),
      cue(2, 'ラララ', 6020, 8000), // folds into row rep=1 with chainEndMs=8000
      cue(3, '了解。', 9000, 11000), // kana-free Japanese line
      cue(4, 'えっ', 12000, 12400), // short 400 ms row → 50 % = 200 ms threshold
      cue(5, '静かだね', 15000, 17000), // only a near-miss (< 300 ms) secondary cue
    ];
    const rows = buildTranscriptRows(primary, { mergeKaraoke: true, hideSigns: true });

    const signMarkup = { layer: 0, hasMove: true, hasKaraoke: false, isDrawing: false, isComment: false, playResX: 1280, playResY: 720 };
    const secondary: SubtitleCue[] = [
      cue(0, '早啊，小鸟。今天也这么早。', 1050, 2950),
      // Sign overlapping row 0 → ignored
      { ...cue(1, '【校門】', 1000, 3000), markup: signMarkup },
      // Two zh cues + a duplicate layer under chain-folded row rep=1 ([4000, 8000])
      cue(2, '啦啦啦（上）', 4000, 5800),
      cue(3, '啦啦啦（上）', 4000, 5800),
      cue(4, '啦啦啦（下）', 6000, 7900),
      // Bilingual secondary with kana-free Japanese line matching primary row 3
      cue(5, '了解。\n明白。', 9000, 11000),
      // Short cue near-miss: 150 ms overlap on 400 ms row (< 200 ms = 50 % of 400 ms) → excluded
      cue(6, '诶（错位）', 12250, 13000),
      // Long cue near-miss: 250 ms overlap on 2000 ms row (< 300 ms) → excluded
      cue(7, '真安静啊（错位）', 16750, 18750),
    ];

    const matched = matchSecondaryCuesToRows(rows, secondary);
    expect([...matched.entries()]).toEqual([
      [0, '早啊，小鸟。今天也这么早。'],
      [1, '啦啦啦（上）\n啦啦啦（下）'],
      [3, '明白。'],
    ]);
    expect(matched.has(4)).toBe(false);
    expect(matched.has(5)).toBe(false);
  });
});
