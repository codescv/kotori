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
  });

  it('tolerates a missing header with a warning and skips junk blocks', () => {
    const track = parseVtt('00:01.000 --> 00:02.000\nA\n\njunk without timing\n\n00:03.000 --> 00:04.000 align:start\nB');
    expect(track.cues.map((c) => c.text)).toEqual(['A', 'B']);
    expect(track.warnings[0]).toBe('missing WEBVTT header');
    expect(track.warnings).toHaveLength(2);
  });
});
