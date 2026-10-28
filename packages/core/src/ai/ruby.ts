/**
 * Furigana segmentation that always reproduces the sentence:
 * `buildRuby(s, raw).map(r => r.base).join('') === s` holds for every input.
 */
import type { CharSpan, RubySegment, SpanAlignment } from '../types';
import { isKana, isKanji, isPunctuationOrSpace, katakanaToHiragana } from '../util/text';
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

/** A chunk (or word) whose reading can repair split ruby inside its span. */
export interface RubyReadingSpan {
  readonly charSpan: CharSpan;
  readonly reading: string;
  /** Unaligned chunks are skipped (their span is empty / meaningless). */
  readonly alignment?: SpanAlignment | undefined;
}

/** Comparable reading: katakana → hiragana, punctuation / whitespace removed. */
function readingKey(text: string): string {
  let out = '';
  for (const ch of katakanaToHiragana(text)) if (!isPunctuationOrSpace(ch)) out += ch;
  return out;
}

/**
 * Repair jukujikun / ateji readings that the model split per kanji.
 *
 * For each aligned chunk with a `reading`, look at the sentence ruby segments
 * inside its `charSpan`. When the chunk's kanji form ONE contiguous run of 2+
 * kanji-bearing segments (e.g. `明(あ)` `日(ひ)`) and the concatenated
 * segment readings (`ruby ?? base`) disagree with `chunk.reading`, the run is
 * merged into a single group-ruby segment whose reading is `chunk.reading`
 * minus the kana before / after the run:
 *
 *   `明(あ)日(ひ)の` + reading `あしたの` → `明日(あした)の`
 *
 * Chunks whose reading cannot be reconciled with the surrounding kana, whose
 * span cuts through a segment, or with kanji split by kana (`見(み)て行(い)く`)
 * are left untouched. The result still concatenates to the same text.
 */
export function normalizeJukujikunRuby(sentenceRuby: readonly RubySegment[], chunks: readonly RubyReadingSpan[]): RubySegment[] {
  const out = [...sentenceRuby];
  for (const chunk of chunks) {
    if (chunk.alignment === 'unaligned') continue;
    const [from, to] = chunk.charSpan;
    const reading = readingKey(chunk.reading ?? '');
    if (to <= from || !reading) continue;
    const first = out.findIndex((r) => r.charSpan[1] > from);
    if (first < 0) continue;
    let end = first;
    while (end < out.length && (out[end]?.charSpan[0] ?? to) < to) end++;
    const segs = out.slice(first, end);
    if (segs.length === 0 || (segs[0]?.charSpan[0] ?? 0) < from || (segs[segs.length - 1]?.charSpan[1] ?? 0) > to) continue;
    const kanjiIdx: number[] = [];
    segs.forEach((r, i) => {
      if (hasKanji(r.base)) kanjiIdx.push(i);
    });
    if (kanjiIdx.length < 2) continue;
    const k0 = kanjiIdx[0] ?? 0;
    const k1 = kanjiIdx[kanjiIdx.length - 1] ?? 0;
    if (k1 - k0 + 1 !== kanjiIdx.length) continue;
    if (readingKey(segs.map((r) => r.ruby ?? r.base).join('')) === reading) continue;
    const prefix = readingKey(segs.slice(0, k0).map((r) => r.base).join(''));
    const suffix = readingKey(segs.slice(k1 + 1).map((r) => r.base).join(''));
    if (!reading.startsWith(prefix) || !reading.endsWith(suffix) || reading.length <= prefix.length + suffix.length) continue;
    const middle = reading.slice(prefix.length, reading.length - suffix.length);
    if (![...middle].every((ch) => isKana(ch))) continue;
    const run = segs.slice(k0, k1 + 1);
    const base = run.map((r) => r.base).join('');
    out.splice(first + k0, run.length, seg(base, run[0]?.charSpan[0] ?? from, middle));
  }
  return out;
}
