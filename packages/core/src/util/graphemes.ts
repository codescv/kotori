/**
 * Grapheme helpers backed by `Intl.Segmenter` (available in Node 22+, modern
 * browsers and Android WebView). Falls back to code points when the segmenter
 * is unavailable.
 */

/** A grapheme cluster with its UTF-16 offsets inside the source string. */
export interface GraphemeSegment {
  readonly text: string;
  /** UTF-16 start offset (inclusive). */
  readonly start: number;
  /** UTF-16 end offset (exclusive). */
  readonly end: number;
}

let segmenter: Intl.Segmenter | null | undefined;

/** Lazily create (and memoise) a grapheme segmenter; `null` when unsupported. */
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
  }
  return segmenter;
}

/** Segment `text` into grapheme clusters with UTF-16 offsets. */
export function segmentGraphemes(text: string): GraphemeSegment[] {
  const out: GraphemeSegment[] = [];
  const seg = getSegmenter();
  if (seg) {
    for (const s of seg.segment(text)) out.push({ text: s.segment, start: s.index, end: s.index + s.segment.length });
    return out;
  }
  let i = 0;
  for (const cp of text) {
    out.push({ text: cp, start: i, end: i + cp.length });
    i += cp.length;
  }
  return out;
}

/** Split `text` into grapheme cluster strings. */
export function splitGraphemes(text: string): string[] {
  return segmentGraphemes(text).map((s) => s.text);
}

/** Number of grapheme clusters in `text`. */
export function graphemeCount(text: string): number {
  const seg = getSegmenter();
  if (!seg) return [...text].length;
  let n = 0;
  for (const _ of seg.segment(text)) n++;
  return n;
}
