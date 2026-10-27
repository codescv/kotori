import { describe, expect, it } from 'vitest';
import { parseAss, parseAssMarkup, stripAssTags } from './ass';
import { readFixtureText } from './fixtures.testutil';

describe('stripAssTags', () => {
  it('removes override blocks and converts escapes', () => {
    expect(stripAssTags('{\\an8\\fs40}上{\\i1}の{\\i0}行\\N下\\nの\\h行')).toBe('上の行\n下\nの 行');
    expect(stripAssTags('{\\t(0,500,\\fscx120\\fad(1,2))}Hi')).toBe('Hi');
    expect(stripAssTags('{\\p1}m 0 0 l 10 10{\\p0}')).toBe('');
    expect(stripAssTags('{\\k20}手|て{\\k30}紙|がみ')).toBe('手紙');
    expect(stripAssTags('a|b {unclosed')).toBe('a|b {unclosed');
    expect(stripAssTags('{\\pos(460,1020)\\c&H00ffff&}これこそﾊﾞﾝﾄﾞ女子って感じ｡\\N')).toBe('これこそバンド女子って感じ。');
  });
});

describe('parseAssMarkup', () => {
  const info = { playResX: 1280, playResY: 720 };

  it('extracts pos / an / fad / layer / style / actor', () => {
    expect(
      parseAssMarkup({ kind: 'Dialogue', layer: 2, style: 'OP', name: 'Singer', text: '{\\an7\\pos(461,672)\\fad(250,250)}手' }, info),
    ).toEqual({
      layer: 2,
      styleName: 'OP',
      alignment: 7,
      posFraction: { xFraction: 461 / 1280, yFraction: 672 / 720 },
      hasMove: false,
      fade: { inMs: 250, outMs: 250 },
      hasKaraoke: false,
      isDrawing: false,
      isComment: false,
      playResX: 1280,
      playResY: 720,
      actor: 'Singer',
    });
  });

  it('handles legacy \\a, \\move, complex \\fade, karaoke, drawings and comments', () => {
    const m = parseAssMarkup(
      { kind: 'Comment', layer: 0, text: '{\\a6\\move(0,0,10,10)\\fade(255,0,255,0,100,900,1000)\\kf50\\p2}m 0 0' },
      info,
    );
    expect(m).toMatchObject({ alignment: 8, hasMove: true, fade: { inMs: 100, outMs: 100 }, hasKaraoke: true, isDrawing: true, isComment: true });
    expect(m).not.toHaveProperty('posFraction');
    expect(m).not.toHaveProperty('styleName');
    expect(m).not.toHaveProperty('actor');
  });
});

describe('parseAss', () => {
  it('parses the karaoke fixture', () => {
    const track = parseAss(readFixtureText('karaoke-per-char.ass'));
    expect(track.warnings).toEqual([]);
    expect(track.info).toEqual({ format: 'ass', encoding: 'utf-8', title: 'Kotori karaoke fixture', styles: ['Default', 'OP', 'Sign'] });
    expect(track.cues).toHaveLength(22);
    track.cues.forEach((c, k) => expect(c.index).toBe(k));

    const [comment, dialogue, sign, drawing, it1, it2, furigana, firstChar] = track.cues;
    expect(comment).toMatchObject({ startMs: 1000, endMs: 3500, text: 'こんにちは、\n世界！', markup: { isComment: true } });
    expect(dialogue).toMatchObject({ text: 'こんにちは、\n世界！', rawText: 'こんにちは、\\N世界！', markup: { isComment: false, actor: 'Kotori' } });
    expect(sign).toMatchObject({ text: '看板', markup: { hasMove: true, styleName: 'Sign' } });
    expect(drawing).toMatchObject({ text: '', markup: { isDrawing: true } });
    expect(it1).toMatchObject({ text: 'これはテスト です', markup: { layer: 0 } });
    expect(it2).toMatchObject({ text: 'これはテスト です', markup: { layer: 1 } });
    expect(furigana).toMatchObject({ text: '手紙', markup: { hasKaraoke: true } });
    expect(firstChar).toMatchObject({
      startMs: 10000,
      endMs: 12800,
      text: '手',
      rawText: '{\\an7\\pos(461,672)\\fad(250,250)}手',
      markup: { alignment: 7, posFraction: { xFraction: 461 / 1280, yFraction: 672 / 720 }, fade: { inMs: 250, outMs: 250 }, playResX: 1280, playResY: 720 },
    });
    // Commas inside the Text column survive.
    expect(track.cues[17]?.text).toBe('Well, then — top');
  });

  it('defaults PlayRes, honours custom Format order, skips bad timing', () => {
    const track = parseAss(
      [
        '[Script Info]',
        'PlayResY: 480',
        '[Events]',
        'Format: Start, End, Layer, Style, Text',
        'Dialogue: 0:00:02.00,0:00:03.00,3,Default,{\\pos(320,240)}B, too',
        'Dialogue: 0:00:01.00,0:00:01.50,0,Default,A',
        'Dialogue: nope,0:00:01.50,0,Default,X',
      ].join('\n'),
    );
    expect(track.cues.map((c) => c.text)).toEqual(['A', 'B, too']);
    expect(track.cues[1]?.markup).toMatchObject({ layer: 3, playResX: 640, playResY: 480, posFraction: { xFraction: 0.5, yFraction: 0.5 } });
    expect(track.warnings).toHaveLength(1);
    expect(parseAss('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x').cues[0]?.markup).toMatchObject({ playResX: 384, playResY: 288 });
  });
});
