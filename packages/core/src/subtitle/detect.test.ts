import { describe, expect, it } from 'vitest';
import { decodeSubtitleBytes, detectSubtitleFormat } from './detect';
import { readFixtureBytes } from './fixtures.testutil';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Encode a mostly-ASCII string as UTF-16 (BMP only). */
function utf16(s: string, le: boolean): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = le ? c & 0xff : c >> 8;
    out[i * 2 + 1] = le ? c >> 8 : c & 0xff;
  }
  return out;
}

describe('decodeSubtitleBytes', () => {
  it('decodes plain UTF-8', () => {
    expect(decodeSubtitleBytes(utf8('1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n'))).toEqual({
      text: '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n',
      encoding: 'utf-8',
    });
  });

  it('strips a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('WEBVTT')]);
    expect(decodeSubtitleBytes(bytes)).toEqual({ text: 'WEBVTT', encoding: 'utf-8' });
  });

  it('honours UTF-16 BOMs and sniffs BOM-less UTF-16LE', () => {
    const text = '1\r\n00:00:01,000 --> 00:00:02,000\r\nテスト\r\n';
    expect(decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, ...utf16(text, true)]))).toEqual({ text, encoding: 'utf-16le' });
    expect(decodeSubtitleBytes(new Uint8Array([0xfe, 0xff, ...utf16(text, false)]))).toEqual({ text, encoding: 'utf-16be' });
    expect(decodeSubtitleBytes(utf16(text, true))).toEqual({ text, encoding: 'utf-16le' });
  });

  it('falls back to Shift_JIS for a real Shift_JIS SRT', () => {
    const { text, encoding } = decodeSubtitleBytes(readFixtureBytes('shift-jis.srt'));
    expect(encoding).toBe('shift_jis');
    expect(text).toContain('「おはよう」');
    expect(text).toContain('いい天気ですね。');
  });

  it('prefers EUC-JP when it looks more Japanese than Shift_JIS', () => {
    const { text, encoding } = decodeSubtitleBytes(readFixtureBytes('euc-jp.srt'));
    expect(encoding).toBe('euc-jp');
    expect(text).toContain('重なった字幕');
  });
});

describe('detectSubtitleFormat', () => {
  it('sniffs strong headers before the file name', () => {
    expect(detectSubtitleFormat('[Script Info]\nTitle: x', 'wrong.srt')).toBe('ass');
    expect(detectSubtitleFormat('\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nhi', 'x.srt')).toBe('vtt');
  });

  it('uses the extension, then SRT timing lines', () => {
    expect(detectSubtitleFormat('garbage', 'ep01.ja.ASS')).toBe('ass');
    expect(detectSubtitleFormat('garbage', 'ep01.ssa')).toBe('ass');
    expect(detectSubtitleFormat('00:00:01.000 --> 00:00:02.000\nhi', 'ep01.vtt')).toBe('vtt');
    expect(detectSubtitleFormat('1\r\n00:00:01,000 --> 00:00:02,000\r\nhi')).toBe('srt');
    expect(detectSubtitleFormat('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi')).toBe('ass');
    expect(detectSubtitleFormat('just some text', 'notes.txt')).toBeUndefined();
  });
});
