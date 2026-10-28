/**
 * Cue lookup, navigation, delay and multi-cue sentence helpers. All pure.
 *
 * Unless stated otherwise, functions assume `cues` is sorted by `startMs`
 * (every parser in this module guarantees that) and that `cues[k].index === k`.
 */
import type { CharSpan, ExplainSource, SubtitleCue } from '../types';
import { KotoriError } from '../util/errors';
import { TERMINAL_PUNCTUATION } from '../util/text';

/** Subtitle-flavoured {@link ExplainSource}. */
export type SubtitleExplainSource = ExplainSource & { readonly kind: 'subtitle' };

/** Result of {@link mergeCuesToSentence}. */
export interface MergedSentence {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /** `cues.map(c => c.index)`, in input order. */
  readonly cueIndexes: readonly number[];
  /** Parallel to `cueIndexes`: span of each cue's `text` inside `text`. */
  readonly cueCharSpans: readonly CharSpan[];
}

/**
 * Stable-sort cues by `startMs` (file order breaks ties, which is the ASS
 * z-order) and renumber `index` to the new positions.
 */
export function sortCuesByStart(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues
    .map((cue, order) => ({ cue, order }))
    .sort((a, b) => a.cue.startMs - b.cue.startMs || a.order - b.order)
    .map(({ cue }, index) => (cue.index === index ? cue : { ...cue, index }));
}

/** Number of cues whose `startMs <= ms` (binary search; cues sorted by start). */
function countStartedBy(cues: readonly SubtitleCue[], ms: number): number {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cues[mid] as SubtitleCue).startMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Position of the cue on screen at `ms` (half-open `[startMs, endMs)`). With
 * overlapping cues the latest-starting active cue wins. `-1` when none.
 */
export function cueIndexAt(cues: readonly SubtitleCue[], ms: number): number {
  for (let i = countStartedBy(cues, ms) - 1; i >= 0; i--) {
    if ((cues[i] as SubtitleCue).endMs > ms) return i;
  }
  return -1;
}

/** Positions of every cue active at `ms` (half-open), ascending. */
export function activeCueIndexes(cues: readonly SubtitleCue[], ms: number): number[] {
  const out: number[] = [];
  const n = countStartedBy(cues, ms);
  for (let i = 0; i < n; i++) {
    if ((cues[i] as SubtitleCue).endMs > ms) out.push(i);
  }
  return out;
}

/** Position of the first cue starting strictly after `ms`; `-1` when none. */
export function nextCueIndex(cues: readonly SubtitleCue[], ms: number): number {
  const i = countStartedBy(cues, ms);
  return i < cues.length ? i : -1;
}

/**
 * Position of the cue a "previous line" action should jump to: the last cue
 * starting before `ms - graceMs`. With the default 1 s grace, pressing
 * "previous" mid-line restarts the current line, while pressing it right
 * after a line began goes to the line before. `-1` when none.
 */
export function prevCueIndex(cues: readonly SubtitleCue[], ms: number, graceMs = 1000): number {
  let lo = 0;
  let hi = cues.length;
  const limit = ms - graceMs;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cues[mid] as SubtitleCue).startMs < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Shift every cue by `delayMs` (positive = later), clamping times at 0.
 * Returns the input array unchanged when `delayMs` is 0.
 */
export function applyDelay(cues: readonly SubtitleCue[], delayMs: number): readonly SubtitleCue[] {
  if (!delayMs) return cues;
  return cues.map((c) => ({
    ...c,
    startMs: Math.max(0, c.startMs + delayMs),
    endMs: Math.max(0, c.endMs + delayMs),
  }));
}

/** Characters that open a new utterance (quotes, brackets, speaker dashes). */
const OPENERS = /^[「『（(【［[〈《“‘"'\-－‐―–—・♪]/u;

/** Separator between two consecutive cue texts in a merged sentence. */
function separatorBetween(prev: string, next: string): string {
  if (prev === '' || next === '') return '';
  // Latin text (translations, English songs) keeps a word boundary.
  if (/[A-Za-z0-9,;:'"]$/.test(prev) && /^[A-Za-z0-9]/.test(next)) return ' ';
  const continues = !TERMINAL_PUNCTUATION.test(prev) && !OPENERS.test(next) && !/^\s/u.test(next);
  return continues ? '' : '\n';
}

/**
 * Join several cues into the one sentence that gets explained. Cue texts are
 * concatenated directly when the previous text has no terminal punctuation and
 * the next one continues it (does not open a quote / dash); otherwise they are
 * separated by `\n` (or a space between two Latin words). Separators belong to
 * no cue: `cueCharSpans[k]` covers exactly `cues[k].text`.
 *
 * @throws KotoriError `invalid-argument` for an empty list.
 */
export function mergeCuesToSentence(cues: readonly SubtitleCue[]): MergedSentence {
  if (cues.length === 0) throw new KotoriError('invalid-argument', 'mergeCuesToSentence needs at least one cue');
  let text = '';
  let startMs = Infinity;
  let endMs = -Infinity;
  let prevText = '';
  const cueIndexes: number[] = [];
  const cueCharSpans: CharSpan[] = [];
  for (const cue of cues) {
    text += separatorBetween(prevText, cue.text);
    cueCharSpans.push([text.length, text.length + cue.text.length]);
    text += cue.text;
    if (cue.text !== '') prevText = cue.text;
    cueIndexes.push(cue.index);
    startMs = Math.min(startMs, cue.startMs);
    endMs = Math.max(endMs, cue.endMs);
  }
  return { text, startMs, endMs, cueIndexes, cueCharSpans };
}

/**
 * Translate a click at `(cueIndex, localCharIndex)` in the overlay / transcript
 * to an index into `ExplainRequest.sentence`. `localCharIndex` is clamped to
 * the cue's span.
 *
 * @throws KotoriError `invalid-argument` when `cueIndex` is not part of `source`.
 */
export function cueOffsetToSentenceIndex(source: SubtitleExplainSource, cueIndex: number, localCharIndex: number): number {
  const k = source.cueIndexes.indexOf(cueIndex);
  const span = k >= 0 ? source.cueCharSpans[k] : undefined;
  if (!span) throw new KotoriError('invalid-argument', `cue ${cueIndex} is not part of this sentence`, { details: { cueIndex } });
  const [start, end] = span;
  return start + Math.min(Math.max(0, localCharIndex), end - start);
}

/**
 * Inverse of {@link cueOffsetToSentenceIndex}: which cue (and where inside it)
 * owns `sentenceIndex`. `undefined` for separators / out-of-range indexes.
 */
export function sentenceIndexToCueOffset(
  source: SubtitleExplainSource,
  sentenceIndex: number,
): { cueIndex: number; localCharIndex: number } | undefined {
  for (let k = 0; k < source.cueCharSpans.length; k++) {
    const span = source.cueCharSpans[k] as CharSpan;
    const cueIndex = source.cueIndexes[k];
    if (cueIndex !== undefined && sentenceIndex >= span[0] && sentenceIndex < span[1]) {
      return { cueIndex, localCharIndex: sentenceIndex - span[0] };
    }
  }
  return undefined;
}

/** Result of {@link splitBilingualCueText}. */
export interface BilingualCueText {
  /** The Japanese line(s); the whole input when the cue is not bilingual. */
  readonly primaryJa: string;
  /** Translation line(s) (Chinese / English / …) when detected. */
  readonly secondaryTranslation?: string | undefined;
}

const KANA_RE = /[\u3040-\u30ff]/u;
/** CJK ideographs or Latin letters (a translation line must contain some). */
const CJK_OR_LATIN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z\uff21-\uff3a\uff41-\uff5a]/u;

/**
 * Split a bilingual fansub cue (`日本語\n中文翻译`) into its Japanese and
 * translation parts. A cue is bilingual when it has 2+ non-empty lines, the
 * first line contains kana (`[\u3040-\u30ff]`) and every following line has
 * zero kana but some CJK / Latin text. Otherwise the whole text is returned
 * as `primaryJa` unchanged.
 */
export function splitBilingualCueText(text: string): BilingualCueText {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) return { primaryJa: text };
  const [first, ...rest] = lines as [string, ...string[]];
  if (!KANA_RE.test(first)) return { primaryJa: text };
  if (!rest.every((l) => !KANA_RE.test(l) && CJK_OR_LATIN_RE.test(l))) return { primaryJa: text };
  return { primaryJa: first, secondaryTranslation: rest.join('\n') };
}
