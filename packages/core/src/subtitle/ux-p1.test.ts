import { describe, expect, it } from 'vitest';
import type { SubtitleCue } from '../types';
import { splitBilingualCueText } from './cue-utils';
import { mergePerCharacterCueGroups } from './merge-per-char';
import { buildSubtitleContext, buildTranscriptRows } from './transcript';

const cue = (index: number, text: string, startMs: number, endMs: number, styleName?: string): SubtitleCue => ({
  index,
  startMs,
  endMs,
  text,
  rawText: text,
  ...(styleName
    ? { markup: { layer: 0, styleName, hasMove: false, hasKaraoke: false, isDrawing: false, isComment: false, playResX: 1280, playResY: 720 } }
    : {}),
});

describe('mergePerCharacterCueGroups typewriter pass', () => {
  it('merges 3+ back-to-back short cues into one line', () => {
    const cues = [
      cue(0, '前の台詞です', 0, 900),
      cue(1, 'こ', 1000, 1080, 'TW'),
      cue(2, 'ん', 1080, 1160, 'TW'),
      cue(3, 'にち', 1150, 1300, 'TW'), // 10 ms overlap allowed
      cue(4, 'は', 1400, 2500, 'TW'), // 100 ms gap allowed
      cue(5, '次の台詞', 3000, 4000),
    ];
    const { byRep, repByRaw } = mergePerCharacterCueGroups(cues);
    expect([...byRep.entries()].map(([k, c]) => [k, c.text, c.startMs, c.endMs])).toEqual([[1, 'こんにちは', 1000, 2500]]);
    expect([...repByRaw.entries()]).toEqual([[1, 1], [2, 1], [3, 1], [4, 1]]);
    const rows = buildTranscriptRows(cues, { mergeKaraoke: true, hideSigns: true });
    expect(rows.map((r) => r.cue.text)).toEqual(['前の台詞です', 'こんにちは', '次の台詞']);
  });

  it('does not merge runs that are too short, gapped, overlapping, mixed-style or too long', () => {
    expect(mergePerCharacterCueGroups([cue(0, 'え', 0, 100), cue(1, 'あ', 100, 200)]).byRep.size).toBe(0);
    expect(mergePerCharacterCueGroups([cue(0, 'え', 0, 100), cue(1, 'あ', 300, 400), cue(2, 'う', 400, 500)]).byRep.size).toBe(0);
    expect(mergePerCharacterCueGroups([cue(0, 'え', 0, 1000), cue(1, 'あ', 0, 1000), cue(2, 'う', 0, 1000)]).byRep.size).toBe(0);
    expect(mergePerCharacterCueGroups([cue(0, 'え', 0, 100, 'A'), cue(1, 'あ', 100, 200, 'B'), cue(2, 'う', 200, 300, 'A')]).byRep.size).toBe(0);
    expect(mergePerCharacterCueGroups([cue(0, 'え', 0, 100), cue(1, 'あ', 100, 200), cue(2, 'う', 200, 10_500)]).byRep.size).toBe(0);
    expect(mergePerCharacterCueGroups([cue(0, 'えっ', 0, 100), cue(1, '本当', 100, 200), cue(2, 'ですか', 200, 300)]).byRep.size).toBe(0);
  });
});

describe('splitBilingualCueText', () => {
  it('splits Japanese + Chinese / English lines', () => {
    expect(splitBilingualCueText('何してるの？\n你在干什么？')).toEqual({ primaryJa: '何してるの？', secondaryTranslation: '你在干什么？' });
    expect(splitBilingualCueText('行くぞ\nLet\'s go\n走吧')).toEqual({ primaryJa: '行くぞ', secondaryTranslation: "Let's go\n走吧" });
  });

  it('keeps monolingual and two-line Japanese cues whole', () => {
    expect(splitBilingualCueText('こんにちは')).toEqual({ primaryJa: 'こんにちは' });
    expect(splitBilingualCueText('そうか\nわかった')).toEqual({ primaryJa: 'そうか\nわかった' });
    expect(splitBilingualCueText('東京\n北京')).toEqual({ primaryJa: '東京\n北京' }); // no kana in line 1
    expect(splitBilingualCueText('はい\n…')).toEqual({ primaryJa: 'はい\n…' }); // line 2 has no text
  });
});

describe('buildSubtitleContext', () => {
  const rows = [
    { text: 'A0', actor: '' },
    { text: 'A1', actor: '太郎' },
    { text: 'A2\nmore' },
    { text: 'A3', actor: ' 花子 ' },
    { text: '  ' },
    { text: 'A5' },
    { text: 'A6' },
  ];

  it('formats [Actor] text, skips empty rows and reports the speaker', () => {
    expect(buildSubtitleContext(rows, 3)).toEqual({ contextBefore: ['[太郎] A1', 'A2 more'], contextAfter: ['A5'], speaker: '花子' });
    expect(buildSubtitleContext(rows, 0)).toEqual({ contextBefore: [], contextAfter: ['[太郎] A1'] });
    expect(buildSubtitleContext(rows, 6, 3, 2)).toEqual({ contextBefore: ['A2 more', '[花子] A3', 'A5'], contextAfter: [] });
  });

  it('is deterministic so single and batch explain share context', () => {
    expect(buildSubtitleContext(rows, 2)).toEqual(buildSubtitleContext([...rows], 2));
  });
});
