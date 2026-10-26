/**
 * Furigana segmentation that always reproduces the sentence:
 * `buildRuby(s, raw).map(r => r.base).join('') === s` holds for every input.
 */
import type { CharSpan, RubySegment } from '../types';
import { isKanji, katakanaToHiragana } from '../util/text';
import { alignSpans } from './span-align';

/** Model-provided ruby unit. */
export interface RawRubyInput {
  readonly base: string;
  readonly ruby?: string | undefined;
}

/** Whether `text` contains at least one kanji. */
export function hasKanji(text: string): boolean {
  for (const ch of text) if (isKanji(ch)) return true;
  return false;
}

/** Clean a model reading: trim, katakana → hiragana; `undefined` when empty. */
function cleanReading(ruby: string | undefined, base: string): string | undefined {
  if (ruby === undefined) return undefined;
  const r = katakanaToHiragana(ruby.trim());
  if (!r || r === katakanaToHiragana(base)) return undefined;
  return r;
}

/** Build a segment, omitting `ruby` when absent. */
function seg(base: string, start: number, ruby?: string): RubySegment {
  const charSpan: CharSpan = [start, start + base.length];
  return ruby === undefined ? { base, charSpan } : { base, ruby, charSpan };
}

/**
 * Split `text` (located at `offset` in the sentence) into alternating
 * kanji / non-kanji runs, with no readings.
 */
export function plainRuns(text: string, offset: number): RubySegment[] {
  const out: RubySegment[] = [];
  let runStart = 0;
  let runKanji: boolean | undefined;
  let i = 0;
  for (const ch of text) {
    const k = isKanji(ch);
    if (runKanji !== undefined && k !== runKanji) {
      out.push(seg(text.slice(runStart, i), offset + runStart));
      runStart = i;
    }
    runKanji = k;
    i += ch.length;
  }
  if (i > runStart) out.push(seg(text.slice(runStart, i), offset + runStart));
  return out;
}

/**
 * Build `RubySegment[]` for `sentence` from the model's `raw` segmentation.
 *
 * Fast path: when the raw bases concatenate to `sentence`, they are used
 * verbatim (readings kept only on kanji-bearing segments). Otherwise each raw
 * base with a reading is aligned onto the sentence (`alignSpans`); aligned
 * kanji-bearing spans keep their reading and everything else is emitted as
 * plain kanji / kana runs without ruby.
 */
export function buildRuby(sentence: string, raw: readonly RawRubyInput[]): RubySegment[] {
  if (sentence.length === 0) return [];
  const bases = raw.map((r) => r.base);
  if (bases.join('') === sentence) {
    const out: RubySegment[] = [];
    let pos = 0;
    for (const r of raw) {
      if (!r.base) continue;
      out.push(seg(r.base, pos, hasKanji(r.base) ? cleanReading(r.ruby, r.base) : undefined));
      pos += r.base.length;
    }
    return out;
  }

  // Fallback: attribute readings via alignment, fill the gaps with plain runs.
  // Only kanji-bearing segments with a reading are aligned: they are distinctive,
  // so a stray kana base cannot drag the monotonic cursor far ahead.
  const candidates = raw.filter((r) => r.ruby !== undefined && hasKanji(r.base));
  const { spans, alignment } = alignSpans(
    sentence,
    candidates.map((r) => r.base),
  );
  const out: RubySegment[] = [];
  let pos = 0;
  candidates.forEach((r, k) => {
    const span = spans[k];
    if (!span || alignment[k] === 'unaligned') return;
    const [s, e] = span;
    if (e <= s || s < pos) return;
    const base = sentence.slice(s, e);
    const reading = hasKanji(base) ? cleanReading(r.ruby, base) : undefined;
    if (reading === undefined) return; // leave to plain-run filling
    if (s > pos) out.push(...plainRuns(sentence.slice(pos, s), pos));
    out.push(seg(base, s, reading));
    pos = e;
  });
  if (pos < sentence.length) out.push(...plainRuns(sentence.slice(pos), pos));
  return out;
}

/**
 * Restrict sentence-level ruby to `span`, splitting segments that straddle
 * the boundary. Split pieces lose their reading (it cannot be attributed to
 * part of a base). Coordinates stay in sentence space.
 */
export function sliceRuby(ruby: readonly RubySegment[], span: CharSpan): RubySegment[] {
  const [from, to] = span;
  const out: RubySegment[] = [];
  for (const r of ruby) {
    const [s, e] = r.charSpan;
    if (e <= from || s >= to) continue;
    const cs = Math.max(s, from);
    const ce = Math.min(e, to);
    if (cs === s && ce === e) out.push(r);
    else out.push(...plainRuns(r.base.slice(cs - s, ce - s), cs));
  }
  return out;
}
