import { describe, expect, it } from 'vitest';
import { readFixtureText } from './fixtures.testutil';
import { parseVtt } from './vtt';

describe('parseVtt', () => {
  it('parses the ruby fixture (CRLF, STYLE/NOTE, ids, settings, voice/class/timestamps)', () => {
    const text = readFixtureText('ruby.vtt');
    expect(text).toContain('\r\n');
    const track = parseVtt(text);
    expect(track.info).toEqual({ format: 'vtt', encoding: 'utf-8' });
    expect(track.warnings).toEqual([]);
    expect(track.cues.map((c) => [c.index, c.startMs, c.endMs, c.text])).toEqual([
      [0, 1000, 3000, '漢字を読む'],
      [1, 2500, 4000, '静かに&ゆっくり'],
      [2, 5000, 7000, 'カラオケ'],
    ]);
    expect(track.cues[0]?.rawText).toContain('<rt>かんじ</rt>');
    expect(track.cues[0]?.ruby).toEqual([
      { base: '漢字', ruby: 'かんじ', charSpan: [0, 2] },
      { base: '読', ruby: 'よ', charSpan: [3, 4] },
    ]);
    expect(track.cues[1]?.ruby).toBeUndefined();
    expect(track.cues[2]?.ruby).toBeUndefined();
  });

  it('parses multi-line VTT cues with <ruby>, half-width kana, and strips stray tags', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      '  <ruby>五百城<rt>いおき</rt></ruby><ruby>茉央<rt>まお</rt></ruby>  ',
      'ﾊﾞﾅﾅﾏﾝの<ruby>設楽<rt>したら</rt></ruby><img src=x onerror=alert(1)>',
    ].join('\n');
    const track = parseVtt(vtt);
    expect(track.cues).toHaveLength(1);
    const cue = track.cues[0]!;
    expect(cue.text).toBe('五百城茉央\nバナナマンの設楽');
    expect(cue.ruby).toEqual([
      { base: '五百城', ruby: 'いおき', charSpan: [0, 3] },
      { base: '茉央', ruby: 'まお', charSpan: [3, 5] },
      { base: '設楽', ruby: 'したら', charSpan: [12, 14] },
    ]);
    for (const seg of cue.ruby ?? []) {
      expect(cue.text.slice(seg.charSpan[0], seg.charSpan[1])).toBe(seg.base);
    }
  });

  it('tolerates a missing header with a warning and skips junk blocks', () => {
    const track = parseVtt('00:01.000 --> 00:02.000\nA\n\njunk without timing\n\n00:03.000 --> 00:04.000 align:start\nB');
    expect(track.cues.map((c) => c.text)).toEqual(['A', 'B']);
    expect(track.warnings[0]).toBe('missing WEBVTT header');
    expect(track.warnings).toHaveLength(2);
  });
});
