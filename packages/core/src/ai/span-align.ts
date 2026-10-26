/**
 * Deterministic alignment of model-provided `surface` strings back onto the
 * source sentence. The model never emits indices; this is the only place
 * where character spans are created.
 */
import type { CharSpan, SpanAlignment } from '../types';
import { isPunctuationOrSpace, normaliseJapaneseWithMap } from '../util/text';

export interface AlignResult {
  readonly spans: CharSpan[];
  readonly alignment: SpanAlignment[];
}

/**
 * Align `surfaces` (in order) onto `sentence` with a monotonic cursor:
 * 1. exact `indexOf(surface, cursor)` → `exact`;
 * 2. match on normalised forms (NFKC, no spaces, `～`↔`〜`, long-vowel marks,
 *    katakana→hiragana), projected back to original offsets → `fuzzy`;
 * 3. otherwise the empty span `[cursor, cursor)` → `unaligned`.
 *
 * Spans never overlap and are non-decreasing; a later match never starts
 * before the previous span's end.
 */
export function alignSpans(sentence: string, surfaces: readonly string[]): AlignResult {
  const spans: CharSpan[] = [];
  const alignment: SpanAlignment[] = [];
  // Normalised sentence computed lazily (only needed for fuzzy matches).
  let norm: ReturnType<typeof normaliseJapaneseWithMap> | undefined;
  let cursor = 0;

  for (const surface of surfaces) {
    if (!surface) {
      spans.push([cursor, cursor]);
      alignment.push('unaligned');
      continue;
    }
    // Pass 1: verbatim.
    const idx = sentence.indexOf(surface, cursor);
    if (idx >= 0) {
      const end = idx + surface.length;
      spans.push([idx, end]);
      alignment.push('exact');
      cursor = end;
      continue;
    }
    // Pass 2: normalised comparison mapped back to source offsets.
    norm ??= normaliseJapaneseWithMap(sentence);
    const needle = normaliseJapaneseWithMap(surface).text;
    if (needle) {
      // First normalised position whose source offset is at/after the cursor.
      let from = 0;
      while (from < norm.text.length && (norm.map[from] ?? 0) < cursor) from++;
      const nIdx = norm.text.indexOf(needle, from);
      if (nIdx >= 0) {
        const start = norm.map[nIdx] ?? cursor;
        const end = norm.endMap[nIdx + needle.length - 1] ?? start;
        spans.push([start, end]);
        alignment.push('fuzzy');
        cursor = end;
        continue;
      }
    }
    spans.push([cursor, cursor]);
    alignment.push('unaligned');
  }
  return { spans, alignment };
}

/**
 * Clamp spans into `[0, length]`, fix inverted spans and enforce monotonic,
 * non-overlapping order (each start ≥ previous end).
 */
export function clampSpans(spans: readonly CharSpan[], length: number): CharSpan[] {
  const out: CharSpan[] = [];
  let prevEnd = 0;
  for (const [s, e] of spans) {
    const cs = Math.min(Math.max(Number.isFinite(s) ? Math.trunc(s) : 0, 0), length);
    const ce = Math.min(Math.max(Number.isFinite(e) ? Math.trunc(e) : cs, 0), length);
    const start = Math.max(cs, prevEnd);
    const end = Math.max(start, ce);
    out.push([start, end]);
    prevEnd = end;
  }
  return out;
}

/**
 * Fraction (0..1) of the sentence's non-space, non-punctuation UTF-16 units
 * covered by `spans`. A sentence with no such characters counts as fully
 * covered (1).
 */
export function spansCover(sentence: string, spans: readonly CharSpan[]): number {
  const covered = new Uint8Array(sentence.length);
  for (const [s, e] of spans) for (let i = Math.max(0, s); i < Math.min(e, sentence.length); i++) covered[i] = 1;
  let total = 0;
  let hit = 0;
  let i = 0;
  for (const ch of sentence) {
    if (!isPunctuationOrSpace(ch)) {
      total += ch.length;
      for (let k = 0; k < ch.length; k++) hit += covered[i + k] ?? 0;
    }
    i += ch.length;
  }
  return total === 0 ? 1 : hit / total;
}
