import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../types';
import { KotoriError } from '../util/errors';
import {
  activeCueIndexes,
  applyDelay,
  cueIndexAt,
  cueOffsetToSentenceIndex,
  dropDuplicateLines,
  isBilingualTrack,
  mergeCuesToSentence,
  nextCueIndex,
  prevCueIndex,
  sentenceIndexToCueOffset,
  sortCuesByStart,
  translationTextOf,
  type SubtitleExplainSource,
} from './cue-utils';
import { buildTranscriptRows } from './transcript';

const cue = (index: number, text: string, startMs: number, endMs: number): SubtitleCue => ({ index, startMs, endMs, text, rawText: text });

// 0: [1000,3000) 1: [2000,2500) overlaps 0, 2: [5000,6000)
const cues = [cue(0, 'A', 1000, 3000), cue(1, 'B', 2000, 2500), cue(2, 'C', 5000, 6000)];

const source = (m: ReturnType<typeof mergeCuesToSentence>): SubtitleExplainSource => ({
  kind: 'subtitle',
  episodeId: 'ep',
  trackId: 'tr',
  cueIndexes: m.cueIndexes,
  cueCharSpans: m.cueCharSpans,
  startMs: m.startMs,
  endMs: m.endMs,
});

describe('sortCuesByStart', () => {
  it('stable-sorts and re-indexes', () => {
    const sorted = sortCuesByStart([cue(0, 'late', 500, 600), cue(1, 'first', 100, 200), cue(2, 'tie', 100, 300)]);
    expect(sorted.map((c) => [c.index, c.text])).toEqual([
      [0, 'first'],
      [1, 'tie'],
      [2, 'late'],
    ]);
  });
});

describe('cue lookup', () => {
  it('cueIndexAt picks the latest-starting active cue (half-open)', () => {
    expect(cueIndexAt(cues, 999)).toBe(-1);
    expect(cueIndexAt(cues, 1000)).toBe(0);
    expect(cueIndexAt(cues, 2200)).toBe(1);
    expect(cueIndexAt(cues, 2500)).toBe(0);
    expect(cueIndexAt(cues, 3000)).toBe(-1);
    expect(cueIndexAt(cues, 5500)).toBe(2);
    expect(cueIndexAt([], 0)).toBe(-1);
  });

  it('activeCueIndexes lists every active cue', () => {
    expect(activeCueIndexes(cues, 2200)).toEqual([0, 1]);
    expect(activeCueIndexes(cues, 4000)).toEqual([]);
  });

  it('nextCueIndex / prevCueIndex navigate by start time', () => {
    expect(nextCueIndex(cues, 0)).toBe(0);
    expect(nextCueIndex(cues, 1000)).toBe(1);
    expect(nextCueIndex(cues, 5000)).toBe(-1);
    expect(prevCueIndex(cues, 5500)).toBe(1); // within 1 s grace of C → previous line
    expect(prevCueIndex(cues, 6500)).toBe(2); // mid/after C → restart C
    expect(prevCueIndex(cues, 5500, 0)).toBe(2);
    expect(prevCueIndex(cues, 1000, 0)).toBe(-1);
  });
});

describe('applyDelay', () => {
  it('shifts and clamps, and is identity for 0', () => {
    expect(applyDelay(cues, 0)).toBe(cues);
    expect(applyDelay(cues, 500).map((c) => [c.startMs, c.endMs])).toEqual([
      [1500, 3500],
      [2500, 3000],
      [5500, 6500],
    ]);
    expect(applyDelay(cues, -1500)[0]).toMatchObject({ startMs: 0, endMs: 1500 });
  });
});

describe('mergeCuesToSentence', () => {
  it('joins continuations without a separator and spans each cue', () => {
    const m = mergeCuesToSentence([cue(4, '今日は', 1000, 2000), cue(5, 'いい天気ですね。', 2000, 3500)]);
    expect(m).toEqual({ text: '今日はいい天気ですね。', startMs: 1000, endMs: 3500, cueIndexes: [4, 5], cueCharSpans: [[0, 3], [3, 11]] });
  });

  it('uses \\n after terminal punctuation or before an opener, space between Latin words', () => {
    expect(mergeCuesToSentence([cue(0, 'はい。', 0, 1), cue(1, 'そうです', 1, 2)]).text).toBe('はい。\nそうです');
    expect(mergeCuesToSentence([cue(0, 'それは', 0, 1), cue(1, '「夢」だ', 1, 2)]).text).toBe('それは\n「夢」だ');
    const latin = mergeCuesToSentence([cue(0, 'I want to', 0, 1), cue(1, 'go home', 1, 2)]);
    expect(latin.text).toBe('I want to go home');
    expect(latin.cueCharSpans).toEqual([[0, 9], [10, 17]]);
  });

  it('yields [[0, len]] for a single cue and throws on empty input', () => {
    expect(mergeCuesToSentence([cue(7, '一つ', 0, 1)]).cueCharSpans).toEqual([[0, 2]]);
    expect(() => mergeCuesToSentence([])).toThrow(KotoriError);
  });
});

describe('cue ⇄ sentence offsets', () => {
  const merged = mergeCuesToSentence([cue(3, 'はい。', 0, 1000), cue(4, '行こう', 1000, 2000)]); // 'はい。\n行こう'
  const src = source(merged);

  it('cueOffsetToSentenceIndex maps and clamps', () => {
    expect(cueOffsetToSentenceIndex(src, 3, 1)).toBe(1);
    expect(cueOffsetToSentenceIndex(src, 4, 0)).toBe(4);
    expect(cueOffsetToSentenceIndex(src, 4, 99)).toBe(7);
    expect(() => cueOffsetToSentenceIndex(src, 9, 0)).toThrow(KotoriError);
  });

  it('sentenceIndexToCueOffset inverts it; separators belong to no cue', () => {
    expect(sentenceIndexToCueOffset(src, 2)).toEqual({ cueIndex: 3, localCharIndex: 2 });
    expect(sentenceIndexToCueOffset(src, 3)).toBeUndefined();
    expect(sentenceIndexToCueOffset(src, 5)).toEqual({ cueIndex: 4, localCharIndex: 1 });
    expect(sentenceIndexToCueOffset(src, 7)).toBeUndefined();
    for (let i = 0; i < merged.text.length; i++) {
      const off = sentenceIndexToCueOffset(src, i);
      if (off) expect(cueOffsetToSentenceIndex(src, off.cueIndex, off.localCharIndex)).toBe(i);
    }
  });
});

describe('secondary subtitle cue helpers', () => {
  it('translationTextOf extracts non-kana translation lines regardless of line order', () => {
    expect(translationTextOf('おはよう、ことり。\n早啊，小鸟。')).toBe('早啊，小鸟。');
    expect(translationTextOf('早啊，小鸟。\nおはよう、ことり。')).toBe('早啊，小鸟。');
    expect(translationTextOf('早啊，小鸟。\nおはよう、ことり。\n今天也这么早。')).toBe('早啊，小鸟。\n今天也这么早。');
    expect(translationTextOf('早啊，小鸟。\n今天也这么早。')).toBe('早啊，小鸟。\n今天也这么早。');
    expect(translationTextOf('おはよう\n今日も早いね')).toBe('おはよう\n今日も早いね');
    expect(translationTextOf('Good morning!')).toBe('Good morning!');
    expect(translationTextOf('おはよう\r\nGood morning!')).toBe('Good morning!');
    expect(translationTextOf('')).toBe('');
    expect(translationTextOf('  \r\n  ')).toBe('');
  });

  it('dropDuplicateLines removes lines matching normalised primary lines (incl. kana-free Japanese and identical cues)', () => {
    expect(dropDuplicateLines('了解。\n明白。', new Set(['了解。']))).toBe('明白。');
    expect(dropDuplicateLines('何　？\r\n什么？', new Set(['何？']))).toBe('什么？');
    expect(dropDuplicateLines('おはよう、ことり。', new Set(['おはよう、ことり。']))).toBe('');
    expect(dropDuplicateLines('早啊，小鸟。\n\n今天也这么早。', new Set(['おはよう']))).toBe('早啊，小鸟。\n今天也这么早。');
  });

  it('isBilingualTrack detects bilingual row cues while karaoke-heavy raw cues stay below threshold until merged', () => {
    expect(isBilingualTrack([])).toBe(false);
    const signOnly: SubtitleCue[] = [
      {
        index: 0,
        startMs: 0,
        endMs: 1000,
        text: 'おはよう\n早安',
        rawText: '',
        markup: { layer: 0, hasMove: true, hasKaraoke: false, isDrawing: false, isComment: false, playResX: 1280, playResY: 720 },
      },
    ];
    expect(isBilingualTrack(signOnly)).toBe(false);

    // 4 bilingual dialogue cues + 30 per-char OP typewriter cues → 4/34 < 0.3 raw, 4/5 >= 0.3 after transcript merge.
    const raw: SubtitleCue[] = [];
    for (let i = 0; i < 30; i++) {
      raw.push({
        index: raw.length,
        startMs: i * 50,
        endMs: (i + 1) * 50,
        text: 'あ',
        rawText: 'あ',
        markup: { layer: 0, styleName: 'OP', hasMove: false, hasKaraoke: false, isDrawing: false, isComment: false, playResX: 1280, playResY: 720 },
      });
    }
    for (let j = 0; j < 4; j++) {
      const startMs = 5000 + j * 2000;
      raw.push(cue(raw.length, `おはよう${j}\n早安${j}`, startMs, startMs + 1500));
    }
    expect(isBilingualTrack(raw)).toBe(false);
    const rowCues = buildTranscriptRows(raw, { mergeKaraoke: true, hideSigns: true }).map((r) => r.cue);
    expect(isBilingualTrack(rowCues)).toBe(true);
  });
});
