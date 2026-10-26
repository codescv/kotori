/**
 * WebVTT (`.vtt`) parser. Cue settings (`line:`, `position:`, `align:` …),
 * `NOTE` / `STYLE` / `REGION` blocks and cue identifiers are ignored.
 */
import type { ParsedSubtitleTrack } from '../types';
import { parseClock } from '../util/time';
import { finishTimedCues, splitSubtitleLines, stripSubtitleHtml, TIMING_LINE, type RawTimedCue } from './srt';

/**
 * Parse WebVTT text. Blocks are separated by blank lines; a block is a cue when
 * its first or second line is a timing line. Payload tags (`<ruby>`/`<rt>`
 * folded to base, `<c>`, `<v>`, `<i>`, karaoke timestamps) are stripped.
 * Tolerates a missing `WEBVTT` header, CRLF and overlapping cues; cues are
 * stable-sorted by start time and re-indexed.
 */
export function parseVtt(text: string): ParsedSubtitleTrack {
  const lines = splitSubtitleLines(text);
  const warnings: string[] = [];
  if (!/^WEBVTT(?:[ \t]|$)/.test(lines[0] ?? '')) warnings.push('missing WEBVTT header');
  const raw: RawTimedCue[] = [];
  let i = 0;
  while (i < lines.length) {
    // Collect one block of consecutive non-blank lines.
    while (i < lines.length && (lines[i] as string).trim() === '') i++;
    const block: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() !== '') block.push(lines[i++] as string);
    if (block.length === 0) break;
    const first = block[0] as string;
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/.test(first)) continue;
    const timingAt = TIMING_LINE.test(first) ? 0 : TIMING_LINE.test(block[1] ?? '') ? 1 : -1;
    if (timingAt < 0) {
      warnings.push(`skipped block without timing: ${first.slice(0, 40)}`);
      continue;
    }
    const m = TIMING_LINE.exec(block[timingAt] as string);
    const startMs = parseClock(m?.[1] ?? '');
    const endMs = parseClock(m?.[2] ?? '');
    if (startMs === undefined || endMs === undefined) {
      warnings.push(`unparseable timing: ${block[timingAt] ?? ''}`);
      continue;
    }
    raw.push({ startMs, endMs, rawText: block.slice(timingAt + 1).join('\n') });
  }
  if (raw.length === 0) warnings.push('no VTT cues found');
  return { info: { format: 'vtt', encoding: 'utf-8' }, cues: finishTimedCues(raw, stripSubtitleHtml, warnings), warnings };
}
