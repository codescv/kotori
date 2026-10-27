/**
 * Advanced SubStation Alpha (`.ass` / `.ssa`) parser. Rendering is plain text
 * (no libass): this extracts the clean text plus the small {@link AssMarkup}
 * subset the app needs (karaoke merging, sign/drawing filtering).
 */
import type { AssMarkup, ParsedSubtitleTrack, SubtitleCue } from '../types';
import { parseClock } from '../util/time';
import { sortCuesByStart } from './cue-utils';
import { normalizeJapaneseKana, splitSubtitleLines } from './srt';

/** `[Script Info]` values relevant to markup normalisation. */
export interface AssScriptInfo {
  /** `PlayResX` (defaults per libass rules; 384 when both are absent). */
  readonly playResX: number;
  /** `PlayResY` (defaults per libass rules; 288 when both are absent). */
  readonly playResY: number;
  readonly title?: string;
}

/** One `Dialogue:` / `Comment:` line split into its columns. */
export interface AssEvent {
  readonly kind: 'Dialogue' | 'Comment';
  readonly layer: number;
  /** `Style` column (omitted when empty). */
  readonly style?: string;
  /** `Name` / Actor column (omitted when empty). */
  readonly name?: string;
  /** Raw `Text` column including override blocks. */
  readonly text: string;
}

/** Override-tag facts collected while scanning an event's text. */
interface AssScan {
  text: string;
  pos?: readonly [number, number];
  alignment?: number;
  hasMove: boolean;
  fade?: { inMs: number; outMs: number };
  hasKaraoke: boolean;
  isDrawing: boolean;
}

/** Legacy SSA `\a` alignment → numpad `\an`. */
const LEGACY_ALIGNMENT: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 };

/** Split an override block body (between `{` and `}`) into tags, respecting parentheses. */
function tokeniseOverrideBlock(block: string): string[] {
  const tags: string[] = [];
  let j = block.indexOf('\\');
  while (j >= 0 && j < block.length) {
    let k = j + 1;
    let depth = 0;
    while (k < block.length) {
      const c = block[k];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '\\' && depth === 0) break;
      k++;
    }
    tags.push(block.slice(j + 1, k).trim());
    j = k;
  }
  return tags;
}

/** Parse comma-separated numeric arguments of `name(…)`. */
function tagArgs(tag: string): number[] {
  const open = tag.indexOf('(');
  const close = tag.lastIndexOf(')');
  const inner = tag.slice(open + 1, close > open ? close : undefined);
  return inner.split(',').map((s) => Number(s.trim()));
}

/** Apply one override tag to the scan state; returns the new `\p` drawing level (or the old one). */
function applyTag(tag: string, scan: AssScan, drawing: number): number {
  if (/^pos\s*\(/.test(tag)) {
    const [x, y] = tagArgs(tag);
    if (scan.pos === undefined && x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) scan.pos = [x, y];
  } else if (/^move\s*\(/.test(tag)) {
    scan.hasMove = true;
  } else if (/^fade?\s*\(/.test(tag)) {
    const a = tagArgs(tag);
    if (scan.fade === undefined && a.every(Number.isFinite)) {
      if (a.length === 2) scan.fade = { inMs: a[0] as number, outMs: a[1] as number };
      else if (a.length === 7) scan.fade = { inMs: (a[4] as number) - (a[3] as number), outMs: (a[6] as number) - (a[5] as number) };
    }
  } else if (/^an\d/.test(tag)) {
    const n = Number(tag.slice(2, 3));
    if (scan.alignment === undefined && n >= 1 && n <= 9) scan.alignment = n;
  } else if (/^a\d+$/.test(tag)) {
    const n = LEGACY_ALIGNMENT[Number(tag.slice(1))];
    if (scan.alignment === undefined && n !== undefined) scan.alignment = n;
  } else if (/^(?:k|K|kf|ko)\d/.test(tag)) {
    scan.hasKaraoke = true;
  } else if (/^p\d+$/.test(tag)) {
    const level = Number(tag.slice(1));
    if (level > 0) scan.isDrawing = true;
    return level;
  }
  // `\t(...)` animations and every other tag are dropped.
  return drawing;
}

/** Trim each line, normalise half-width katakana, and drop blank lines. */
function tidyLines(text: string): string {
  return normalizeJapaneseKana(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Single pass over an event's text: strips override blocks (collecting the
 * tags we care about), converts `\N`/`\n` → newline and `\h` → space, drops
 * `\p1+` drawing commands, and folds Aegisub karaoke furigana
 * (`{\k20}漢|かん`) to the base text. An unclosed `{` is kept literally.
 */
function scanAssText(raw: string): AssScan {
  const scan: AssScan = { text: '', hasMove: false, hasKaraoke: false, isDrawing: false };
  let out = '';
  let drawing = 0;
  let inFurigana = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === '{') {
      const close = raw.indexOf('}', i + 1);
      if (close >= 0) {
        for (const tag of tokeniseOverrideBlock(raw.slice(i + 1, close))) drawing = applyTag(tag, scan, drawing);
        inFurigana = false;
        i = close + 1;
        continue;
      }
    }
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'N' || next === 'n' || next === 'h') {
        if (drawing === 0 && !inFurigana) out += next === 'h' ? ' ' : '\n';
        i += 2;
        continue;
      }
    }
    if (ch === '|' && scan.hasKaraoke) inFurigana = true;
    if (drawing === 0 && !inFurigana) out += ch;
    i++;
  }
  scan.text = tidyLines(out);
  return scan;
}

/**
 * Plain text of an ASS event payload: override blocks removed, `\N`/`\n` →
 * `\n`, `\h` → space, drawings (`\p1`) removed, karaoke furigana folded to base.
 */
export function stripAssTags(raw: string): string {
  return scanAssText(raw).text;
}

/**
 * Extract the {@link AssMarkup} subset for one event: `\pos` (as fractions of
 * PlayRes), `\an` / legacy `\a`, `\move`, `\fad` / `\fade`, `\k*`, `\p1`,
 * layer, style, actor and `Comment:`. The first `\pos` / `\an` / `\fad` wins.
 */
export function parseAssMarkup(
  event: Pick<AssEvent, 'kind' | 'layer' | 'text'> & { readonly style?: string; readonly name?: string },
  scriptInfo: Pick<AssScriptInfo, 'playResX' | 'playResY'>,
): AssMarkup {
  const scan = scanAssText(event.text);
  const { playResX, playResY } = scriptInfo;
  return {
    layer: event.layer,
    ...(event.style ? { styleName: event.style } : {}),
    ...(scan.alignment !== undefined ? { alignment: scan.alignment } : {}),
    ...(scan.pos ? { posFraction: { xFraction: scan.pos[0] / playResX, yFraction: scan.pos[1] / playResY } } : {}),
    hasMove: scan.hasMove,
    ...(scan.fade ? { fade: scan.fade } : {}),
    hasKaraoke: scan.hasKaraoke,
    isDrawing: scan.isDrawing,
    isComment: event.kind === 'Comment',
    playResX,
    playResY,
    ...(event.name ? { actor: event.name } : {}),
  };
}

/** Default `[Events]` column order (ASS v4+). */
const DEFAULT_EVENT_FORMAT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

/** Resolve PlayRes defaults the way libass does. */
function resolvePlayRes(x: number | undefined, y: number | undefined): { playResX: number; playResY: number } {
  if (x && y) return { playResX: x, playResY: y };
  if (x) return { playResX: x, playResY: x === 1280 ? 1024 : (x * 3) / 4 };
  if (y) return { playResX: (y * 4) / 3, playResY: y };
  return { playResX: 384, playResY: 288 };
}

/** Split an event value into `columns` cells; the last one (Text) keeps its commas. */
function splitEventColumns(value: string, columns: number): string[] {
  const cells: string[] = [];
  let rest = value;
  for (let c = 0; c < columns - 1; c++) {
    const comma = rest.indexOf(',');
    if (comma < 0) break;
    cells.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  cells.push(rest);
  return cells;
}

/**
 * Parse an ASS / SSA script. Reads `[Script Info]` (`PlayResX/Y`, `Title`),
 * style names from `[V4+ Styles]` / `[V4 Styles]`, and `Dialogue:` / `Comment:`
 * events from `[Events]` using its `Format:` column order. Every event becomes
 * a cue (comments flagged `markup.isComment`, drawings `markup.isDrawing`);
 * events with unparseable or non-positive timing are skipped with a warning.
 * Cues are stable-sorted by start time and re-indexed.
 */
export function parseAss(text: string): ParsedSubtitleTrack {
  const warnings: string[] = [];
  const styles: string[] = [];
  let section = '';
  let resX: number | undefined;
  let resY: number | undefined;
  let title: string | undefined;
  let styleFormat: string[] | undefined;
  let eventFormat = DEFAULT_EVENT_FORMAT;
  const events: Array<{ event: AssEvent; startMs: number; endMs: number }> = [];

  for (const line of splitSubtitleLines(text)) {
    const t = line.trim();
    if (t === '' || t.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(t);
    if (header) {
      section = (header[1] as string).trim().toLowerCase();
      continue;
    }
    const colon = t.indexOf(':');
    if (colon < 0) continue;
    const key = t.slice(0, colon).trim().toLowerCase();
    const value = t.slice(colon + 1).replace(/^\s+/, '');

    if (section === 'script info') {
      if (key === 'playresx') resX = Number(value) || undefined;
      else if (key === 'playresy') resY = Number(value) || undefined;
      else if (key === 'title' && value.trim() !== '') title = value.trim();
    } else if (/^v4\+*\s*styles$/.test(section)) {
      if (key === 'format') styleFormat = value.split(',').map((c) => c.trim().toLowerCase());
      else if (key === 'style') {
        const nameIdx = Math.max(0, styleFormat?.indexOf('name') ?? 0);
        const name = value.split(',')[nameIdx]?.trim();
        if (name) styles.push(name);
      }
    } else if (section === 'events') {
      if (key === 'format') {
        eventFormat = value.split(',').map((c) => c.trim().toLowerCase());
      } else if (key === 'dialogue' || key === 'comment') {
        const cells = splitEventColumns(value, eventFormat.length);
        const col = (name: string): string | undefined => {
          const idx = eventFormat.indexOf(name);
          return idx >= 0 ? cells[idx] : undefined;
        };
        const startMs = parseClock(col('start') ?? '');
        const endMs = parseClock(col('end') ?? '');
        if (startMs === undefined || endMs === undefined || endMs <= startMs) {
          warnings.push(`skipped event with bad timing: ${t.slice(0, 60)}`);
          continue;
        }
        const style = col('style')?.trim();
        const name = col('name')?.trim() ?? col('actor')?.trim();
        const event: AssEvent = {
          kind: key === 'comment' ? 'Comment' : 'Dialogue',
          layer: Number.parseInt(col('layer') ?? '0', 10) || 0,
          ...(style ? { style } : {}),
          ...(name ? { name } : {}),
          text: col('text') ?? '',
        };
        events.push({ event, startMs, endMs });
      }
    }
  }

  const scriptInfo = resolvePlayRes(resX, resY);
  const cues: SubtitleCue[] = events.map(({ event, startMs, endMs }, index) => ({
    index,
    startMs,
    endMs,
    text: stripAssTags(event.text),
    rawText: event.text,
    markup: parseAssMarkup(event, scriptInfo),
  }));
  if (cues.length === 0) warnings.push('no ASS events found');
  return {
    info: {
      format: 'ass',
      encoding: 'utf-8',
      ...(title !== undefined ? { title } : {}),
      ...(styles.length > 0 ? { styles } : {}),
    },
    cues: sortCuesByStart(cues),
    warnings,
  };
}
