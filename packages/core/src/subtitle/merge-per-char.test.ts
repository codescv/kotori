import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../types';
import { parseAss } from './ass';
import { readFixtureText } from './fixtures.testutil';
import { mergePerCharacterCueGroups } from './merge-per-char';

/** Per-char karaoke cue at script pixel (x, y) on a 1280×720 canvas. */
function charCue(index: number, text: string, startMs: number, endMs: number, x: number, y = 672, layer = 0): SubtitleCue {
  return {
    index,
    startMs,
    endMs,
    text,
    rawText: `{\\an7\\pos(${x},${y})\\fad(250,250)}${text}`,
    markup: {
      layer,
      alignment: 7,
      posFraction: { xFraction: x / 1280, yFraction: y / 720 },
      hasMove: false,
      fade: { inMs: 250, outMs: 250 },
      hasKaraoke: false,
      isDrawing: false,
      isComment: false,
      playResX: 1280,
      playResY: 720,
    },
  };
}

/** Plain dialogue cue (no markup). */
function plainCue(index: number, text: string, startMs: number, endMs: number): SubtitleCue {
  return { index, startMs, endMs, text, rawText: text };
}

/** Re-index a list so `cues[k].index === k`. */
const indexed = (cues: SubtitleCue[]): SubtitleCue[] => cues.map((c, index) => ({ ...c, index }));

describe('mergePerCharacterCueGroups', () => {
  it('merges the Fushi-style fixture into two lyric lines', () => {
    const { cues } = parseAss(readFixtureText('karaoke-per-char.ass'));
    const { byRep, repByRaw } = mergePerCharacterCueGroups(cues);
    expect([...byRep.keys()]).toEqual([7, 13]);
    expect(byRep.get(7)).toEqual({
      index: 7,
      startMs: 10000,
      endMs: 13000,
      text: '手を伸ばして',
      rawText: cues.slice(7, 13).map((c) => c.rawText).join('\n'),
    });
    expect(byRep.get(7)).not.toHaveProperty('markup');
    expect(byRep.get(13)).toMatchObject({ index: 13, startMs: 12880, endMs: 15620, text: '空へ届け' });
    expect([...repByRaw.entries()]).toEqual([
      [7, 7], [8, 7], [9, 7], [10, 7], [11, 7], [12, 7],
      [13, 13], [14, 13], [15, 13], [16, 13],
    ]);
  });

  it('BUG-1439: consecutive lyric lines overlapping ~120 ms do not chain', () => {
    // Line A: chars fade in 200 ms apart, fade out staggered 40 ms apart → union ends 13000.
    const a = [...'手を伸ばして'].map((ch, k) => charCue(0, ch, 10000 + 200 * k, 12800 + 40 * k, 461 + 30 * k));
    // Line B starts at 12880: inside A's union [10000, 13000] (120 ms overlap) but after
    // A's common on-screen window closed (first char gone at 12800).
    const b = [...'空へ届け'].map((ch, k) => charCue(0, ch, 12880 + 200 * k, 15500 + 40 * k, 461 + 30 * k));
    const cues = indexed([...a, ...b]);
    expect(b[0]!.startMs).toBeLessThan(Math.max(...a.map((c) => c.endMs)));
    const { byRep } = mergePerCharacterCueGroups(cues);
    expect([...byRep.values()].map((c) => c.text)).toEqual(['手を伸ばして', '空へ届け']);
    expect(byRep.get(0)).toMatchObject({ startMs: 10000, endMs: 13000 });
    expect(byRep.get(6)).toMatchObject({ startMs: 12880, endMs: 15620 });
  });

  it('orders group text by xFraction, not file order', () => {
    const cues = indexed([charCue(0, 'ば', 0, 1000, 551), charCue(0, '手', 0, 1000, 461), charCue(0, 'を', 0, 1000, 491)]);
    expect(mergePerCharacterCueGroups(cues).byRep.get(0)?.text).toBe('手をば');
  });

  it('breaks groups on layer, row, non-per-char cues and multi-grapheme text', () => {
    const cues = indexed([
      charCue(0, 'あ', 0, 1000, 100),
      charCue(0, 'い', 0, 1000, 130, 672 + 0.5), // |Δy| = 0.0007 ≤ eps → same row
      charCue(0, 'う', 0, 1000, 160, 700), // different row
      charCue(0, 'え', 0, 1000, 190, 700, 1), // different layer
      charCue(0, 'お', 0, 1000, 220, 700, 1),
      plainCue(0, '会話', 0, 1000), // no \pos → never participates, breaks the run
      charCue(0, 'か', 0, 1000, 250, 700, 1),
      charCue(0, 'きく', 0, 1000, 280, 700, 1), // two graphemes → not per-char
      charCue(0, 'け', 0, 1000, 310, 700, 1), // lone member → not a group
    ]);
    const { byRep, repByRaw } = mergePerCharacterCueGroups(cues);
    expect([...byRep.entries()].map(([k, c]) => [k, c.text])).toEqual([
      [0, 'あい'],
      [3, 'えお'],
    ]);
    expect([...repByRaw.keys()]).toEqual([0, 1, 3, 4]);
  });

  it('treats a combining sequence as one grapheme', () => {
    const cues = indexed([charCue(0, 'か\u3099', 0, 1000, 100), charCue(0, 'き', 0, 1000, 130)]);
    expect(mergePerCharacterCueGroups(cues).byRep.get(0)?.text).toBe('か\u3099き');
  });

  it('returns empty maps for ordinary dialogue', () => {
    const { byRep, repByRaw } = mergePerCharacterCueGroups([plainCue(0, 'こんにちは', 0, 1000), plainCue(1, 'あ', 0, 1000)]);
    expect(byRep.size).toBe(0);
    expect(repByRaw.size).toBe(0);
  });
});
