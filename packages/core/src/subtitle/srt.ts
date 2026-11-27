/**
 * SubRip (`.srt`) parser plus the HTML-ish cue text cleaner shared with WebVTT.
 */
import type { ParsedSubtitleTrack, RubySegment, SubtitleCue } from '../types';
import { katakanaToHiragana } from '../util/text';
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

/** Strip non-ruby HTML / VTT / ASS tags and decode entities on a raw fragment. */
function cleanPlainFragment(raw: string): string {
  return decodeEntities(
    raw
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<\/?[A-Za-z][^<>]*>/g, '')
      .replace(/<\d{1,3}(?::\d{2}){1,2}(?:[.,]\d{1,3})?>/g, '')
      .replace(/\\N/g, '\n')
      .replace(/\\h/g, ' '),
  );
}

/** Clean a `<rt>` reading payload: strip `<rp>` blocks & tags, decode entities, normalise kana, trim. */
function cleanRubyReading(rawRt: string): string {
  const withoutRp = rawRt.replace(/<rp\b[^>]*>[\s\S]*?(?:<\/rp\s*>|$)/gi, '');
  const cleaned = cleanPlainFragment(withoutRp).replace(/\r?\n/g, '');
  return normalizeJapaneseKana(cleaned).trim();
}

/**
 * Apply `normalizeJapaneseKana` while tracking a boundary map of length
 * `input.length + 1` so UTF-16 spans `[start, end)` project onto the normalised
 * string with exact offsets.
 */
function normalizeJapaneseKanaWithMap(input: string): { readonly text: string; readonly map: Int32Array } {
  // Pass 1: half-width katakana & punctuation `[\uff61-\uff9f]+` → NFKC.
  const map1 = new Int32Array(input.length + 1);
  let mid = '';
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code >= 0xff61 && code <= 0xff9f) {
      // Group a half-width kana with an immediately following half-width dakuten/handakuten (ﾞ/ﾟ).
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      const step = next === 0xff9e || next === 0xff9f ? 2 : 1;
      const chunk = input.slice(i, i + step);
      const norm = chunk.normalize('NFKC');
      map1[i] = mid.length;
      if (step === 2) map1[i + 1] = norm.length === 1 ? mid.length : mid.length + 1;
      mid += norm;
      i += step;
    } else {
      map1[i] = mid.length;
      mid += input[i]!;
      i += 1;
    }
  }
  map1[input.length] = mid.length;

  // Pass 2: decomposed combining voiced marks `[\u3040-\u30ff][\u3099\u309a]` → NFC.
  const map2 = new Int32Array(mid.length + 1);
  let out = '';
  let j = 0;
  while (j < mid.length) {
    const code = mid.charCodeAt(j);
    const next = j + 1 < mid.length ? mid.charCodeAt(j + 1) : 0;
    if (code >= 0x3040 && code <= 0x30ff && (next === 0x3099 || next === 0x309a)) {
      const norm = mid.slice(j, j + 2).normalize('NFC');
      map2[j] = out.length;
      map2[j + 1] = norm.length === 1 ? out.length : out.length + 1;
      out += norm;
      j += 2;
    } else {
      map2[j] = out.length;
      out += mid[j]!;
      j += 1;
    }
  }
  map2[mid.length] = out.length;

  const combined = new Int32Array(input.length + 1);
  for (let k = 0; k <= input.length; k++) {
    combined[k] = map2[map1[k]!]!;
  }
  return { text: out, map: combined };
}

/**
 * Per-line `.trim()` and blank-line dropping matching `stripSubtitleHtml`,
 * returning the final string and a boundary map of length `input.length + 1`.
 */
function trimSubtitleLinesWithMap(input: string): { readonly text: string; readonly map: Int32Array } {
  const map = new Int32Array(input.length + 1);
  const keptLines: string[] = [];
  let outPos = 0;
  let lineStart = 0;

  const processLine = (start: number, end: number): void => {
    const rawLine = input.slice(start, end);
    const trimmed = rawLine.trim();
    if (trimmed === '') {
      for (let k = start; k <= end; k++) map[k] = outPos;
      return;
    }
    if (keptLines.length > 0) outPos += 1; // '\n' separator before this non-empty line
    const leadWs = rawLine.length - rawLine.trimStart().length;
    const trimStart = start + leadWs;
    const trimEnd = trimStart + trimmed.length;
    for (let k = start; k <= trimStart; k++) map[k] = outPos;
    for (let k = trimStart + 1; k <= trimEnd; k++) map[k] = outPos + (k - trimStart);
    outPos += trimmed.length;
    for (let k = trimEnd + 1; k <= end; k++) map[k] = outPos;
    keptLines.push(trimmed);
  };

  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === 10) {
      processLine(lineStart, i);
      lineStart = i + 1;
    }
  }
  processLine(lineStart, input.length);
  return { text: keptLines.join('\n'), map };
}

/** Result of {@link parseSubtitleHtmlWithRuby}. */
export interface ParsedSubtitleHtml {
  readonly text: string;
  readonly ruby?: readonly RubySegment[];
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

const RUBY_STRUCT_TAG_RE = /\{\\[^}]*\}|<(\/?)(ruby|rt|rp|rb)(?:\b[^<>]*)?>/gi;
const RT_CLOSE_RE = /<\/rt\s*>|(?=<\/ruby\s*>)/gi;
const RP_CLOSE_RE = /<\/rp\s*>/gi;

/**
 * Parse an SRT / VTT cue payload into plain `text` (identical to
 * {@link stripSubtitleHtml}) plus optional `<ruby>`/`<rt>` furigana segments
 * with exact UTF-16 `charSpan` offsets into `text`.
 *
 * Security: never produces raw HTML; all non-ruby tags are stripped and output
 * strings are plain text safe for React JSX auto-escaping.
 */
export function parseSubtitleHtmlWithRuby(raw: string): ParsedSubtitleHtml {
  if (!/<ruby\b/i.test(raw)) {
    return { text: stripSubtitleHtml(raw) };
  }

  const src = raw.replace(/\r\n?/g, '\n');
  let decoded = '';
  const rawSpans: Array<{ start: number; end: number; reading: string }> = [];

  let inRuby = false;
  let inRb = false;
  let currentBaseStart: number | null = null;
  let pendingBases: Array<{ start: number; end: number }> = [];

  const flushCurrentBase = (): void => {
    if (currentBaseStart !== null) {
      if (decoded.length > currentBaseStart && decoded.slice(currentBaseStart).trim() !== '') {
        pendingBases.push({ start: currentBaseStart, end: decoded.length });
      }
      currentBaseStart = null;
    }
    inRb = false;
  };

  const appendPlain = (slice: string): void => {
    if (slice === '') return;
    const cleaned = cleanPlainFragment(slice);
    if (cleaned === '') return;
    if (inRuby && !inRb && currentBaseStart === null && cleaned.trim() !== '') {
      currentBaseStart = decoded.length;
    }
    decoded += cleaned;
  };

  let cursor = 0;
  RUBY_STRUCT_TAG_RE.lastIndex = 0;
  while (cursor < src.length) {
    RUBY_STRUCT_TAG_RE.lastIndex = cursor;
    const m = RUBY_STRUCT_TAG_RE.exec(src);
    if (!m) {
      appendPlain(src.slice(cursor));
      break;
    }
    const tagStart = m.index;
    const tagEnd = tagStart + m[0].length;

    if (tagStart > cursor) appendPlain(src.slice(cursor, tagStart));
    cursor = tagEnd;

    // ASS override block `{\...}` — skipped identically to `stripSubtitleHtml`.
    if (m[2] === undefined) continue;

    const isClose = m[1] === '/';
    const tagName = m[2].toLowerCase();

    if (tagName === 'ruby') {
      if (!isClose) {
        inRuby = true;
        inRb = false;
        currentBaseStart = null;
        pendingBases = [];
      } else {
        inRuby = false;
        inRb = false;
        currentBaseStart = null;
        pendingBases = [];
      }
      continue;
    }

    if (tagName === 'rb') {
      if (inRuby) {
        if (!isClose) {
          flushCurrentBase();
          inRb = true;
          currentBaseStart = decoded.length;
        } else if (inRb) {
          flushCurrentBase();
        }
      }
      continue;
    }

    if (tagName === 'rp') {
      if (!isClose) {
        if (inRuby && !inRb) flushCurrentBase();
        RP_CLOSE_RE.lastIndex = cursor;
        const closeM = RP_CLOSE_RE.exec(src);
        cursor = closeM ? closeM.index + closeM[0].length : src.length;
      }
      continue;
    }

    if (tagName === 'rt') {
      if (!isClose) {
        if (inRuby) flushCurrentBase();
        RT_CLOSE_RE.lastIndex = cursor;
        const closeM = RT_CLOSE_RE.exec(src);
        const rtEnd = closeM ? closeM.index : src.length;
        const rawRt = src.slice(cursor, rtEnd);
        // Advance past `</rt>`, but stop BEFORE `</ruby>` so the closing `</ruby>` tag is processed next.
        cursor = closeM ? closeM.index + closeM[0].length : src.length;
        if (inRuby) {
          const target = pendingBases.shift();
          if (target && target.end > target.start) {
            const reading = cleanRubyReading(rawRt);
            if (reading !== '') {
              rawSpans.push({ start: target.start, end: target.end, reading });
            }
          }
        }
      }
      continue;
    }
  }

  const norm = normalizeJapaneseKanaWithMap(decoded);
  const trimmed = trimSubtitleLinesWithMap(norm.text);
  const text = trimmed.text;

  if (rawSpans.length === 0 || text === '') {
    return { text };
  }

  const ruby: RubySegment[] = [];
  let prevEnd = 0;
  for (const span of rawSpans) {
    let start = trimmed.map[norm.map[span.start]!]!;
    let end = trimmed.map[norm.map[span.end]!]!;
    if (end <= start) continue;
    // Trim leading/trailing whitespace within the span so ruby floats tightly over base text.
    const rawBase = text.slice(start, end);
    const trimmedBase = rawBase.trim();
    if (trimmedBase === '') continue;
    const lead = rawBase.length - rawBase.trimStart().length;
    start += lead;
    end = start + trimmedBase.length;
    if (start < prevEnd || end > text.length || end <= start) continue;
    const base = text.slice(start, end);
    if (base.includes('\n')) continue;
    // Omit redundant reading identical to base (including katakana/hiragana equivalence).
    if (span.reading === base || katakanaToHiragana(span.reading) === katakanaToHiragana(base)) continue;
    ruby.push({ base, ruby: span.reading, charSpan: [start, end] });
    prevEnd = end;
  }

  return ruby.length > 0 ? { text, ruby } : { text };
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
export function finishTimedCues(
  raw: readonly RawTimedCue[],
  clean: (s: string) => string | ParsedSubtitleHtml,
  warnings: string[],
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const r of raw) {
    if (r.endMs <= r.startMs) {
      warnings.push(`skipped cue with end <= start at ${r.startMs} ms`);
      continue;
    }
    const res = clean(r.rawText);
    const text = typeof res === 'string' ? res : res.text;
    const ruby = typeof res === 'string' ? undefined : res.ruby;
    if (text === '') continue;
    cues.push({
      index: cues.length,
      startMs: r.startMs,
      endMs: r.endMs,
      text,
      rawText: r.rawText,
      ...(ruby && ruby.length > 0 ? { ruby } : {}),
    });
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
  return { info: { format: 'srt', encoding: 'utf-8' }, cues: finishTimedCues(raw, parseSubtitleHtmlWithRuby, warnings), warnings };
}
