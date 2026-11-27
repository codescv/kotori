import { describe, expect, it } from 'vitest';
import { decodeSubtitleBytes } from './detect';
import { readFixtureBytes } from './fixtures.testutil';
import { parseSrt, parseSubtitleHtmlWithRuby, stripSubtitleHtml } from './srt';

describe('stripSubtitleHtml', () => {
  it('removes tags, keeps ruby base, decodes entities', () => {
    expect(stripSubtitleHtml('{\\an8}<i>「<b>やあ</b>」</i>')).toBe('「やあ」');
    expect(stripSubtitleHtml('<ruby>漢字<rt>かんじ</rt></ruby>と<ruby>仮<rp>(</rp><rt>か</rt><rp>)</rp>名</ruby>')).toBe('漢字と仮名');
    expect(stripSubtitleHtml('<font color="#fff">A &amp; B&nbsp;&#x3042;&#12354;</font>')).toBe('A & B ああ');
    expect(stripSubtitleHtml('  上の行 \r\n\r\n 下の行\\N三行目 ')).toBe('上の行\n下の行\n三行目');
    expect(stripSubtitleHtml('a < b > c')).toBe('a < b > c');
    expect(stripSubtitleHtml('これこそﾊﾞﾝﾄﾞ女子って感じ｡')).toBe('これこそバンド女子って感じ。');
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

  it('attaches parsed ruby segments to SRT cues when <ruby> tags are present', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:03,000\n<ruby>漢字<rt>かんじ</rt></ruby>を<ruby>読<rt>よ</rt></ruby>む\n\n' +
      '2\n00:00:04,000 --> 00:00:05,000\nふつうのセリフ\n';
    const track = parseSrt(srt);
    expect(track.cues[0]?.text).toBe('漢字を読む');
    expect(track.cues[0]?.ruby).toEqual([
      { base: '漢字', ruby: 'かんじ', charSpan: [0, 2] },
      { base: '読', ruby: 'よ', charSpan: [3, 4] },
    ]);
    expect(track.cues[1]?.ruby).toBeUndefined();
  });
});

describe('parseSubtitleHtmlWithRuby', () => {
  function assertInvariants(raw: string): ReturnType<typeof parseSubtitleHtmlWithRuby> {
    const res = parseSubtitleHtmlWithRuby(raw);
    expect(res.text).toBe(stripSubtitleHtml(raw));
    if (res.ruby) {
      let prevEnd = 0;
      for (const seg of res.ruby) {
        const [start, end] = seg.charSpan;
        expect(start).toBeGreaterThanOrEqual(prevEnd);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThanOrEqual(res.text.length);
        expect(res.text.slice(start, end)).toBe(seg.base);
        expect(seg.ruby).toBeTruthy();
        prevEnd = end;
      }
    }
    return res;
  }

  it('parses standard <ruby>, <rp>, <rb>, multi-<rt>, attributes, mixed case, and unclosed <rt>', () => {
    expect(assertInvariants('<ruby>漢字<rt>かんじ</rt></ruby>').ruby).toEqual([
      { base: '漢字', ruby: 'かんじ', charSpan: [0, 2] },
    ]);
    expect(assertInvariants('<ruby>漢字<rt>かんじ</rt></ruby>と<ruby>仮<rp>(</rp><rt>か</rt><rp>)</rp>名</ruby>').ruby).toEqual([
      { base: '漢字', ruby: 'かんじ', charSpan: [0, 2] },
      { base: '仮', ruby: 'か', charSpan: [3, 4] },
    ]);
    expect(assertInvariants('<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>').ruby).toEqual([
      { base: '漢', ruby: 'かん', charSpan: [0, 1] },
      { base: '字', ruby: 'じ', charSpan: [1, 2] },
    ]);
    expect(assertInvariants('<ruby><rb>漢</rb><rb>字</rb><rt>かん</rt><rt>じ</rt></ruby>').ruby).toEqual([
      { base: '漢', ruby: 'かん', charSpan: [0, 1] },
      { base: '字', ruby: 'じ', charSpan: [1, 2] },
    ]);
    expect(assertInvariants('<RUBY class="f"><rb>乃木坂</rb><RT lang="ja">のぎざか</RT></RUBY>').ruby).toEqual([
      { base: '乃木坂', ruby: 'のぎざか', charSpan: [0, 3] },
    ]);
    expect(assertInvariants('<ruby>漢字<rt>かんじ</ruby>です').ruby).toEqual([
      { base: '漢字', ruby: 'かんじ', charSpan: [0, 2] },
    ]);
  });

  it('preserves exact UTF-16 charSpans across entities, half-width katakana, combining dakuten, and line trimming', () => {
    const entityRes = assertInvariants('<ruby>A&amp;B<rt>エー&amp;ビー</rt></ruby> &lt; <ruby>漢<rt>&#x304b;&#x3093;</rt></ruby>');
    expect(entityRes.text).toBe('A&B < 漢');
    expect(entityRes.ruby).toEqual([
      { base: 'A&B', ruby: 'エー&ビー', charSpan: [0, 3] },
      { base: '漢', ruby: 'かん', charSpan: [6, 7] },
    ]);

    const kanaRes = assertInvariants('  ﾊﾞﾝﾄﾞ<ruby>女子<rt>ｼﾞｮｼ</rt></ruby>  \r\n\r\n  か\u3099<ruby>漢字<rt>か\u3099んし\u3099</rt></ruby> ');
    expect(kanaRes.text).toBe('バンド女子\nが漢字');
    expect(kanaRes.ruby).toEqual([
      { base: '女子', ruby: 'ジョシ', charSpan: [3, 5] },
      { base: '漢字', ruby: 'がんじ', charSpan: [7, 9] },
    ]);
  });

  it('strips nested/unsafe tags inside base and <rt> and omits empty or redundant readings', () => {
    const xss = assertInvariants(
      '{\\an8}<img src=x onerror=alert(1)><ruby><i>漢</i><span onclick="x">字</span><rt><b>かん</b><img src=x>じ</rt></ruby>',
    );
    expect(xss.text).toBe('漢字');
    expect(xss.ruby).toEqual([{ base: '漢字', ruby: 'かんじ', charSpan: [0, 2] }]);

    expect(assertInvariants('<ruby>漢字<rt>   </rt></ruby>').ruby).toBeUndefined();
    expect(assertInvariants('<ruby>漢字<rt>漢字</rt></ruby>').ruby).toBeUndefined();
    expect(assertInvariants('<ruby>カタカナ<rt>かたかな</rt></ruby>').ruby).toBeUndefined();
  });

  it('handles whitespace before <rb>, <rp> inside unclosed <rt>, ASS overrides wrapping <ruby>, surrogate pairs, and nested <ruby>', () => {
    // Whitespace / indentation before <rb> must never steal or shift <rt> readings.
    expect(assertInvariants('<ruby> <rb>漢</rb><rt>かん</rt></ruby>')).toEqual({
      text: '漢',
      ruby: [{ base: '漢', ruby: 'かん', charSpan: [0, 1] }],
    });
    expect(assertInvariants('<ruby>\n  <rb>漢</rb>\n  <rt>かん</rt>\n</ruby>')).toEqual({
      text: '漢',
      ruby: [{ base: '漢', ruby: 'かん', charSpan: [0, 1] }],
    });
    expect(assertInvariants('<ruby> <rb>漢</rb><rb>字</rb><rt>かん</rt><rt>じ</rt></ruby>')).toEqual({
      text: '漢字',
      ruby: [
        { base: '漢', ruby: 'かん', charSpan: [0, 1] },
        { base: '字', ruby: 'じ', charSpan: [1, 2] },
      ],
    });
    expect(assertInvariants('<ruby>漢<rt>かん</rt> <rb>字</rb><rt>じ</rt></ruby>')).toEqual({
      text: '漢 字',
      ruby: [
        { base: '漢', ruby: 'かん', charSpan: [0, 1] },
        { base: '字', ruby: 'じ', charSpan: [2, 3] },
      ],
    });

    // <rp> inside unclosed <rt> strips the <rp> content cleanly.
    expect(assertInvariants('<ruby>漢<rt>かん<rp>)</rp></ruby>')).toEqual({
      text: '漢',
      ruby: [{ base: '漢', ruby: 'かん', charSpan: [0, 1] }],
    });

    // ASS override block wrapping <ruby> keeps exact parity with stripSubtitleHtml.
    expect(assertInvariants('{\\an8<ruby>漢<rt>かん</rt></ruby>}')).toEqual({ text: '' });

    // Surrogate pairs / emoji before & inside <ruby> preserve exact UTF-16 charSpan offsets.
    expect(assertInvariants('😀<ruby>漢字<rt>かんじ</rt></ruby>')).toEqual({
      text: '😀漢字',
      ruby: [{ base: '漢字', ruby: 'かんじ', charSpan: [2, 4] }],
    });
    expect(assertInvariants('<ruby>𠮷野家<rt>よしのや</rt></ruby>')).toEqual({
      text: '𠮷野家',
      ruby: [{ base: '𠮷野家', ruby: 'よしのや', charSpan: [0, 4] }],
    });

    // Nested <ruby> does not crash or emit overlapping spans.
    const nested = assertInvariants('<ruby>外<ruby>内<rt>うち</rt></ruby></ruby>');
    expect(nested.text).toBe('外内');
    expect(nested.ruby).toEqual([{ base: '内', ruby: 'うち', charSpan: [1, 2] }]);
  });
});
