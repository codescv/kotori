import { describe, expect, it } from 'vitest';
import type { ExplainSource, SubtitleCue } from '@kotori/core';
import { createAnimeFixtures } from '../host/mock/anime';
import {
  buildTranscriptRows,
  cueIndexAt,
  cueOffsetToSentenceIndex,
  formatClock,
  mergeCuesToSentence,
  mergePerCharacterCueGroups,
  sentenceIndexToCueOffset,
} from './cues';

const cue = (index: number, startMs: number, endMs: number, text: string, extra: Partial<SubtitleCue> = {}): SubtitleCue => ({ index, startMs, endMs, text, rawText: text, ...extra });
const kara = (index: number, startMs: number, endMs: number, text: string, x: number, y = 0.9): SubtitleCue =>
  cue(index, startMs, endMs, text, { markup: { layer: 0, hasMove: false, hasKaraoke: false, isDrawing: false, isComment: false, playResX: 1280, playResY: 720, posFraction: { xFraction: x, yFraction: y } } });

describe('mergeCuesToSentence / offset mapping', () => {
  const a = cue(2, 1000, 3000, 'ちょっと待ってくれよ、');
  const b = cue(3, 3100, 5000, 'まだ話は終わってないんだから。');

  it('joins a continued sentence without separator and records per-cue spans', () => {
    const m = mergeCuesToSentence([a, b]);
    expect(m.text).toBe('ちょっと待ってくれよ、まだ話は終わってないんだから。');
    expect(m.cueIndexes).toEqual([2, 3]);
    expect(m.cueCharSpans).toEqual([
      [0, 11],
      [11, 26],
    ]);
    expect([m.startMs, m.endMs]).toEqual([1000, 5000]);
  });

  it('separates complete sentences with a newline owned by no cue', () => {
    const m = mergeCuesToSentence([cue(0, 0, 1, 'うるさいな。'), cue(1, 2, 3, '行かなきゃ')]);
    expect(m.text).toBe('うるさいな。\n行かなきゃ');
    expect(m.cueCharSpans).toEqual([
      [0, 6],
      [7, 12],
    ]);
  });

  it('cueOffsetToSentenceIndex ⇄ sentenceIndexToCueOffset round-trip', () => {
    const m = mergeCuesToSentence([a, b]);
    const src: Extract<ExplainSource, { kind: 'subtitle' }> = { kind: 'subtitle', episodeId: 'e', trackId: 't', cueIndexes: m.cueIndexes, cueCharSpans: m.cueCharSpans, startMs: m.startMs, endMs: m.endMs };
    expect(cueOffsetToSentenceIndex(src, 3, 2)).toBe(13);
    expect(m.text[13]).toBe(b.text[2]);
    expect(sentenceIndexToCueOffset(src, 13)).toEqual({ cueIndex: 3, localCharIndex: 2 });
    expect(sentenceIndexToCueOffset(src, 0)).toEqual({ cueIndex: 2, localCharIndex: 0 });
  });
});

describe('mergePerCharacterCueGroups (Fushi port)', () => {
  it('merges per-char \\pos events sorted by x, breaks on the shrinking common window (BUG-1439)', () => {
    const cues = [
      kara(0, 0, 3000, '手', 0.3),
      kara(1, 150, 3000, '伸', 0.36),
      kara(2, 100, 3000, 'を', 0.33),
      // Next lyric line fades in 100 ms before the previous one ends but after
      // the head's window shrank → new group, not a chained one.
      kara(3, 3050, 6000, '空', 0.3),
      kara(4, 3200, 6000, 'へ', 0.33),
      cue(5, 4000, 5000, '普通の台詞'),
    ];
    const g = mergePerCharacterCueGroups(cues);
    expect(g.byRep.get(0)?.text).toBe('手を伸');
    expect([g.byRep.get(0)?.startMs, g.byRep.get(0)?.endMs]).toEqual([0, 3000]);
    expect(g.byRep.get(3)?.text).toBe('空へ');
    expect(g.repByRaw.get(2)).toBe(0);
    expect(g.repByRaw.get(4)).toBe(3);
    expect(g.repByRaw.has(5)).toBe(false);
    expect(g.byRep.get(0)?.markup).toBeUndefined();
  });

  it('does not merge different rows or single members', () => {
    const g = mergePerCharacterCueGroups([kara(0, 0, 1000, 'あ', 0.1, 0.5), kara(1, 0, 1000, 'い', 0.2, 0.9)]);
    expect(g.byRep.size).toBe(0);
  });
});

describe('buildTranscriptRows', () => {
  const fixture = createAnimeFixtures()[0];
  const parsed = fixture?.cuesByTrack.get('series-kotori-ep1-ja');
  const cues = parsed?.cues ?? [];

  it('merges karaoke OP lyrics, hides signs/comments and de-dups outline layers', () => {
    const rows = buildTranscriptRows(cues, { mergeKaraoke: true, hideSigns: true });
    const texts = rows.map((r) => r.cue.text);
    expect(texts).toContain('手を伸ばして');
    expect(texts).toContain('空へ駆け出そう');
    expect(texts.some((tx) => tx.length === 1)).toBe(false);
    expect(texts).not.toContain('第一話');
    expect(texts).not.toContain('TL note: timing v2');
    expect(texts.filter((tx) => tx === '行かなきゃ')).toHaveLength(1);
    const lyric = rows.find((r) => r.cue.text === '手を伸ばして');
    expect(lyric?.rawIndexes.length).toBe(6);
  });

  it('keeps per-char rows when karaoke merge is off', () => {
    const rows = buildTranscriptRows(cues, { mergeKaraoke: false, hideSigns: false });
    expect(rows.some((r) => r.cue.text === '手')).toBe(true);
    expect(rows.some((r) => r.cue.text === '第一話')).toBe(true);
  });

  it('folds same-text adjacency chains', () => {
    const rows = buildTranscriptRows([cue(0, 0, 1000, 'ラララ'), cue(1, 1020, 2000, 'ラララ'), cue(2, 5000, 6000, 'ラララ')], { mergeKaraoke: true, hideSigns: true });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.chainEndMs).toBe(2000);
    expect(rows[0]?.rawIndexes).toEqual([0, 1]);
  });
});

describe('time helpers', () => {
  it('cueIndexAt finds the on-screen cue', () => {
    const cues = [cue(0, 0, 1000, 'a'), cue(1, 2000, 3000, 'b')];
    expect(cueIndexAt(cues, 2500)).toBe(1);
    expect(cueIndexAt(cues, 1500)).toBe(-1);
  });
  it('formatClock', () => {
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
});
