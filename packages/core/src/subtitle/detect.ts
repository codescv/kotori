/**
 * Subtitle byte decoding (BOM / UTF-8 / Shift_JIS / EUC-JP) and format sniffing.
 * Platform-neutral: relies only on `TextDecoder`.
 */
import type { SubtitleFormat } from '../types';

/** Result of {@link decodeSubtitleBytes}. */
export interface DecodedSubtitleText {
  /** Decoded text with any leading BOM removed. */
  readonly text: string;
  /** WHATWG encoding label actually used (`utf-8`, `utf-16le`, `utf-16be`, `shift_jis`, `euc-jp`). */
  readonly encoding: string;
}

/** Try a strict decode; `undefined` when the bytes are invalid (or the label unsupported). */
function tryDecode(bytes: Uint8Array, label: string): string | undefined {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Lenient decode (replacement chars), falling back to UTF-8 when the label is unsupported. */
function lenientDecode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Heuristic "looks like Japanese" score: hiragana / katakana / common kanji
 * earn points, half-width katakana (the typical symptom of decoding EUC-JP as
 * Shift_JIS) and replacement characters lose points.
 */
function japaneseScore(text: string): number {
  let score = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x3041 && cp <= 0x30ff) score += 2; // hiragana + full-width katakana
    else if (cp >= 0x4e00 && cp <= 0x9fff) score += 1; // CJK ideographs
    else if (cp >= 0x3000 && cp <= 0x303f) score += 1; // CJK punctuation
    else if (cp >= 0xff61 && cp <= 0xff9f) score -= 2; // half-width katakana
    else if (cp === 0xfffd) score -= 5;
  }
  return score;
}

/**
 * Guess UTF-16 without BOM: in mostly-ASCII subtitle text, every other byte
 * is zero. Returns the endianness or `undefined`.
 */
function sniffUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  const n = Math.min(bytes.length - (bytes.length % 2), 512);
  if (n < 8) return undefined;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero > pairs * 0.3 && evenZero < pairs * 0.05) return 'utf-16le';
  if (evenZero > pairs * 0.3 && oddZero < pairs * 0.05) return 'utf-16be';
  return undefined;
}

/**
 * Decode raw subtitle bytes. Order: BOM sniff (UTF-8 / UTF-16LE / UTF-16BE) →
 * BOM-less UTF-16 heuristic → strict UTF-8 → strict Shift_JIS / EUC-JP (the one
 * that looks more like Japanese wins) → lenient Shift_JIS.
 */
export function decodeSubtitleBytes(bytes: Uint8Array): DecodedSubtitleText {
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    return { text: stripBom(lenientDecode(bytes.subarray(3), 'utf-8')), encoding: 'utf-8' };
  }
  if (b0 === 0xff && b1 === 0xfe) {
    return { text: stripBom(lenientDecode(bytes.subarray(2), 'utf-16le')), encoding: 'utf-16le' };
  }
  if (b0 === 0xfe && b1 === 0xff) {
    return { text: stripBom(lenientDecode(bytes.subarray(2), 'utf-16be')), encoding: 'utf-16be' };
  }
  const utf16 = sniffUtf16(bytes);
  if (utf16) return { text: stripBom(lenientDecode(bytes, utf16)), encoding: utf16 };

  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== undefined) return { text: stripBom(utf8), encoding: 'utf-8' };

  const sjis = tryDecode(bytes, 'shift_jis');
  const euc = tryDecode(bytes, 'euc-jp');
  if (sjis !== undefined && euc !== undefined) {
    return japaneseScore(euc) > japaneseScore(sjis) ? { text: euc, encoding: 'euc-jp' } : { text: sjis, encoding: 'shift_jis' };
  }
  if (sjis !== undefined) return { text: sjis, encoding: 'shift_jis' };
  if (euc !== undefined) return { text: euc, encoding: 'euc-jp' };
  return { text: lenientDecode(bytes, 'shift_jis'), encoding: 'shift_jis' };
}

/** Remove a single leading U+FEFF. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const SRT_TIMING = /^\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}/m;
const ANY_TIMING = /^\s*(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?\s*-->/m;

/** Format implied by a file extension, if any. */
function formatFromFileName(fileName: string | undefined): SubtitleFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName ?? '')?.[1]?.toLowerCase();
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (ext === 'vtt' || ext === 'webvtt') return 'vtt';
  if (ext === 'srt') return 'srt';
  return undefined;
}

/**
 * Detect the subtitle format. Strong content signatures win (`[Script Info]` /
 * `[Events]` → ass, leading `WEBVTT` → vtt), then the file extension, then a
 * weak sniff for SRT-style `-->` timing lines. `undefined` when nothing matches.
 */
export function detectSubtitleFormat(text: string, fileName?: string): SubtitleFormat | undefined {
  const head = stripBom(text).slice(0, 4096);
  if (/^\s*WEBVTT(?:[ \t\r\n]|$)/.test(head)) return 'vtt';
  if (/^\s*\[(?:Script Info|V4\+? Styles|Events)\]/im.test(head)) return 'ass';
  const byName = formatFromFileName(fileName);
  if (byName) return byName;
  if (SRT_TIMING.test(head)) return 'srt';
  if (ANY_TIMING.test(head)) return 'srt';
  if (/^\s*Dialogue:\s*\d+,/m.test(head)) return 'ass';
  return undefined;
}
