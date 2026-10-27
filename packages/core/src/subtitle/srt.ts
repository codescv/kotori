/**
 * SubRip (`.srt`) parser plus the HTML-ish cue text cleaner shared with WebVTT.
 */
import type { ParsedSubtitleTrack, SubtitleCue } from '../types';
import { parseClock } from '../util/time';
import { sortCuesByStart } from './cue-utils';

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

/** Decode the handful of HTML entities that appear in SRT / VTT payloads. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Normalise half-width katakana & CJK punctuation (`U+FF61`–`U+FF9F`, e.g.
 * ARIB STD-B24 broadcast captions `これこそﾊﾞﾝﾄﾞ女子って感じ｡` →
 * `これこそバンド女子って感じ。`) and decomposed combining voiced marks
 * (`U+3099` / `U+309A`) into standard precomposed full-width kana (`NFC`).
 */
export function normalizeJapaneseKana(text: string): string {
  return text
    .replace(/[\uff61-\uff9f]+/g, (m) => m.normalize('NFKC'))
    .replace(/[\u3040-\u30ff][\u3099\u309a]/g, (m) => m.normalize('NFC'));
}

/**
 * Clean an SRT / VTT cue payload to plain text: `<ruby>base<rt>reading</rt></ruby>`
 * keeps only the base (also drops `<rp>`), every other HTML / VTT tag
 * (`<i>`, `<font …>`, `<c.cls>`, `<v Name>`, `<00:01.000>`) is removed,
 * ASS-style `{\an8}` override blocks are removed, `\N` → newline, `\h` →
 * space, entities are decoded, half-width katakana are normalised to full-width,
 * and each line is trimmed (blank lines dropped).
 */
export function stripSubtitleHtml(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/<rt\b[^>]*>[\s\S]*?(?:<\/rt\s*>|(?=<\/ruby\s*>)|$)/gi, '')
    .replace(/<rp\b[^>]*>[\s\S]*?(?:<\/rp\s*>|$)/gi, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?[A-Za-z][^<>]*>/g, '')
    .replace(/<\d{1,3}(?::\d{2}){1,2}(?:[.,]\d{1,3})?>/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\h/g, ' ');
  return normalizeJapaneseKana(decodeEntities(text))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** `start --> end` timing line (SRT and VTT share the shape; VTT adds settings). */
export const TIMING_LINE = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)(?:\s|$)/;

/** Normalise newlines, strip a BOM and split into lines. */
export function splitSubtitleLines(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n').split('\n');
}

/** Raw cue gathered by a line scanner before cleaning / sorting. */
export interface RawTimedCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly rawText: string;
}

/**
 * Clean, validate (drops empty and `end <= start` cues with a warning), sort
 * by start and index the cues of an SRT / VTT file.
 */
export function finishTimedCues(raw: readonly RawTimedCue[], clean: (s: string) => string, warnings: string[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const r of raw) {
    if (r.endMs <= r.startMs) {
      warnings.push(`skipped cue with end <= start at ${r.startMs} ms`);
      continue;
    }
    const text = clean(r.rawText);
    if (text === '') continue;
    cues.push({ index: cues.length, startMs: r.startMs, endMs: r.endMs, text, rawText: r.rawText });
  }
  return sortCuesByStart(cues);
}

/**
 * Parse SubRip text. Tolerates CRLF, missing / non-numeric indexes, missing
 * blank lines between cues, `.` instead of `,` for milliseconds, trailing
 * coordinates after the timing and overlapping cues. Cues are stable-sorted by
 * start time and re-indexed.
 */
export function parseSrt(text: string): ParsedSubtitleTrack {
  const lines = splitSubtitleLines(text);
  const warnings: string[] = [];
  const raw: RawTimedCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = TIMING_LINE.exec(lines[i] as string);
    if (!m) {
      i++;
      continue;
    }
    const startMs = parseClock(m[1] as string);
    const endMs = parseClock(m[2] as string);
    i++;
    const body: string[] = [];
    while (i < lines.length) {
      const line = lines[i] as string;
      if (line.trim() === '' || TIMING_LINE.test(line)) break;
      // A bare number directly followed by a timing line is the next cue's index.
      if (/^\s*\d+\s*$/.test(line) && TIMING_LINE.test(lines[i + 1] ?? '')) break;
      body.push(line);
      i++;
    }
    if (startMs === undefined || endMs === undefined) {
      warnings.push(`unparseable timing line ${i}`);
      continue;
    }
    raw.push({ startMs, endMs, rawText: body.join('\n') });
  }
  if (raw.length === 0) warnings.push('no SRT cues found');
  return { info: { format: 'srt', encoding: 'utf-8' }, cues: finishTimedCues(raw, stripSubtitleHtml, warnings), warnings };
}
