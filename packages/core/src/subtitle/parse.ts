/**
 * Format-agnostic subtitle entry point: decode → detect → dispatch.
 */
import type { ParsedSubtitleTrack } from '../types';
import { KotoriError } from '../util/errors';
import { parseAss } from './ass';
import { decodeSubtitleBytes, detectSubtitleFormat } from './detect';
import { parseSrt } from './srt';
import { parseVtt } from './vtt';

/** Input of {@link parseSubtitle}: raw bytes (preferred, encoding is sniffed) or already-decoded text. */
export interface ParseSubtitleInput {
  readonly bytes?: Uint8Array;
  readonly text?: string;
  /** Used as a format hint (`.ass` / `.srt` / `.vtt`) when the content is ambiguous. */
  readonly fileName?: string;
}

/**
 * Parse a subtitle file of any supported format. `bytes` win over `text`;
 * `info.encoding` reports the detected encoding (`utf-8` for `text` input).
 *
 * @throws KotoriError `invalid-argument` when neither `bytes` nor `text` is given,
 *   `unsupported` when the format cannot be determined.
 */
export function parseSubtitle(input: ParseSubtitleInput): ParsedSubtitleTrack {
  let text: string;
  let encoding = 'utf-8';
  if (input.bytes !== undefined) {
    ({ text, encoding } = decodeSubtitleBytes(input.bytes));
  } else if (input.text !== undefined) {
    text = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
  } else {
    throw new KotoriError('invalid-argument', 'parseSubtitle needs bytes or text');
  }
  const format = detectSubtitleFormat(text, input.fileName);
  if (format === undefined) {
    throw new KotoriError('unsupported', 'unrecognised subtitle format', {
      details: input.fileName === undefined ? {} : { fileName: input.fileName },
    });
  }
  const track = format === 'ass' ? parseAss(text) : format === 'vtt' ? parseVtt(text) : parseSrt(text);
  return { ...track, info: { ...track.info, encoding } };
}
