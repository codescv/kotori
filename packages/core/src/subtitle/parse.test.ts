import { describe, expect, it } from 'vitest';
import { KotoriError } from '../util/errors';
import { readFixtureBytes } from './fixtures.testutil';
import { parseSubtitle } from './parse';

describe('parseSubtitle', () => {
  it('decodes + dispatches bytes and reports the encoding', () => {
    const srt = parseSubtitle({ bytes: readFixtureBytes('shift-jis.srt'), fileName: 'ep01.ja.srt' });
    expect(srt.info).toEqual({ format: 'srt', encoding: 'shift_jis' });
    expect(srt.cues[0]?.text).toBe('「おはよう」');

    const ass = parseSubtitle({ bytes: readFixtureBytes('karaoke-per-char.ass') });
    expect(ass.info.format).toBe('ass');
    expect(ass.info.encoding).toBe('utf-8');

    const vtt = parseSubtitle({ bytes: readFixtureBytes('ruby.vtt') });
    expect(vtt.info.format).toBe('vtt');
  });

  it('accepts text input (BOM stripped) and uses the file name hint', () => {
    const track = parseSubtitle({ text: '\uFEFF00:00:01.000 --> 00:00:02.000\nこんにちは', fileName: 'a.vtt' });
    expect(track.info).toEqual({ format: 'vtt', encoding: 'utf-8' });
    expect(track.cues[0]?.text).toBe('こんにちは');
  });

  it('throws typed errors', () => {
    expect(() => parseSubtitle({})).toThrow(KotoriError);
    try {
      parseSubtitle({ text: 'hello', fileName: 'x.txt' });
      expect.unreachable();
    } catch (e) {
      expect((e as KotoriError).code).toBe('unsupported');
    }
  });
});
