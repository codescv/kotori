import { describe, expect, it } from 'vitest';
import { decodeSubtitleBytes } from './detect';
import { readFixtureBytes } from './fixtures.testutil';
import { parseSrt, stripSubtitleHtml } from './srt';

describe('stripSubtitleHtml', () => {
  it('removes tags, keeps ruby base, decodes entities', () => {
    expect(stripSubtitleHtml('{\\an8}<i>「<b>やあ</b>」</i>')).toBe('「やあ」');
    expect(stripSubtitleHtml('<ruby>漢字<rt>かんじ</rt></ruby>と<ruby>仮<rp>(</rp><rt>か</rt><rp>)</rp>名</ruby>')).toBe('漢字と仮名');
    expect(stripSubtitleHtml('<font color="#fff">A &amp; B&nbsp;&#x3042;&#12354;</font>')).toBe('A & B ああ');
    expect(stripSubtitleHtml('  上の行 \r\n\r\n 下の行\\N三行目 ')).toBe('上の行\n下の行\n三行目');
    expect(stripSubtitleHtml('a < b > c')).toBe('a < b > c');
  });
});

describe('parseSrt', () => {
  it('parses the Shift_JIS fixture (CRLF, missing index, settings, overlap)', () => {
    const { text } = decodeSubtitleBytes(readFixtureBytes('shift-jis.srt'));
    const track = parseSrt(text);
    expect(track.info).toEqual({ format: 'srt', encoding: 'utf-8' });
    expect(track.warnings).toEqual([]);
    expect(track.cues.map((c) => [c.index, c.startMs, c.endMs, c.text])).toEqual([
      [0, 1000, 3000, '「おはよう」'],
      [1, 3500, 5000, '今日は\nいい天気ですね。'],
      [2, 4500, 6250, '重なった字幕&テスト'],
      [3, 7000, 8000, '最後の行'],
    ]);
    expect(track.cues[0]?.rawText).toBe('{\\an8}<i>「おはよう」</i>');
    expect(track.cues[0]?.markup).toBeUndefined();
  });

  it('sorts out-of-order cues, drops empty / inverted ones with warnings', () => {
    const track = parseSrt('2\n00:00:05,000 --> 00:00:06,000\nB\n\n1\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:09,000 --> 00:00:08,000\nbad\n\n4\n00:00:10,000 --> 00:00:11,000\n<i></i>\n');
    expect(track.cues.map((c) => [c.index, c.text])).toEqual([
      [0, 'A'],
      [1, 'B'],
    ]);
    expect(track.warnings).toHaveLength(1);
  });

  it('warns on empty input', () => {
    expect(parseSrt('').warnings).toEqual(['no SRT cues found']);
  });
});
