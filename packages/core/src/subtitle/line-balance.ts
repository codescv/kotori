/**
 * Pure linguistic subtitle line-balancing algorithm (§2 of subtitle wrap spec).
 *
 * Platform-neutral: zero DOM / Canvas dependencies. Operates on grapheme
 * clusters in UTF-16 offset space so `<RubyText>` can inject `<br>` elements
 * without shifting `data-char-start` / `data-char-end` indices by a single unit.
 */
import type { CharSpan, RubySegment } from '../types';
import { segmentGraphemes } from '../util/graphemes';
import { isHiragana, isKana, isKanji, isKatakana, TERMINAL_PUNCTUATION } from '../util/text';
import { OPENERS } from './cue-utils';

export interface LineBalanceOptions {
  /** Never split strictly inside `charSpan` of a segment that carries `ruby`. */
  readonly segments?: readonly RubySegment[] | undefined;
  /** Default: auto (`ja` when kana present, `zh` when Han without kana, else `en`). */
  readonly lang?: 'ja' | 'zh' | 'en' | undefined;
  /** Global maximum line budget across the cue (default `3`). */
  readonly maxLines?: number | undefined;
}

export interface LineBreakPlan {
  /** UTF-16 offsets (in `text` space) where a soft line break goes BEFORE the char at that offset. */
  readonly softBreaks: ReadonlySet<number>;
  /** Offsets of existing `'\n'` chars that should be rendered as nothing (orphan re-flow). */
  readonly joinedHardBreaks: ReadonlySet<number>;
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>();
const EMPTY_PLAN: LineBreakPlan = Object.freeze({
  softBreaks: EMPTY_SET,
  joinedHardBreaks: EMPTY_SET,
});

const NARROW_ASCII = new Set([...'iljtfI.,:;\'!|()']);
const WIDE_ASCII = new Set([...'mwMW@%&']);

const KINSOKU_START = new Set([
  ...'、。，．・：；！？!?,.:;)）」』】〉》〕｝］]”’%％ー〜～…‥っゃゅょゎぁぃぅぇぉゕゖァィゥェォッャュョヮヵヶ々ゝゞヽヾ',
]);

const KINSOKU_END = new Set([...'（(「『【〈《〔｛［[“‘"\'＄$￥¥#＃']);

const JA_CLAUSE_PREV = new Set([...'、，。．！？!?…‥」』）)']);
const ZH_CLAUSE_PREV = new Set([...'，、。．；：！？!?…‥）」』】']);
const ZH_PARTICLES = new Set([...'了吗呢吧啊呀嘛']);
const ZH_CONJ_1 = new Set([...'但而就还也又都才却']);
const ZH_CONJ_2 = new Set([
  '因为',
  '所以',
  '如果',
  '可是',
  '不过',
  '然后',
  '虽然',
  '但是',
  '而且',
  '或者',
  '然而',
  '于是',
]);

/**
 * Japanese auxiliary stems/inflections that must never be detached from a
 * preceding kana/kanji stem (§2.3-3b), ordered longest-first for JS `|` matching.
 */
const JA_AUX_RE =
  /^(なかった|ちゃった|じゃった|ました|ません|でした|ちゃう|じゃう|ない|ます|です|てる|てた|られ|させ|れる|せる|れて|れた|せて|せた|たい|そう|よう|た|だ|ん)/u;

/** Bunsetsu-ending particles / conjunctive endings (§2.5 Tier 2 for `ja`). */
const JA_BUNSETSU_TAIL_RE =
  /(けれど|から|まで|より|けど|のに|ので|たら|なら|は|が|を|に|で|と|も|へ|ば|て|し|ね|よ|の)$/u;

/** Demonstrative determiners ending in `の`/`な` excluded from Tier 2. */
const JA_DEMONSTRATIVE_TAIL_RE = /(?:この|その|あの|どの|こんな|そんな|あんな|どんな)$/u;

const COMBINING_RE = /^\p{M}/u;
const HAN_RE = /\p{Script=Han}/u;
const ASCII_WORD_CHAR_RE = /^[A-Za-z0-9'’]$/u;
const LATIN_OR_DIGIT_RE = /^[A-Za-z0-9]$/u;
const LATIN_LETTER_RE = /^[A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A]$/u;
const DIGIT_RE = /^[0-9\uFF10-\uFF19]$/u;
const NUMBER_SEP_RE = /^[.,，．]$/u;

function isZeroWidthCodePoint(cp: number, firstChar: string): boolean {
  return (
    cp < 0x20 ||
    cp === 0x7f ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    COMBINING_RE.test(firstChar)
  );
}

function isEastAsianWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2014 || // —
    cp === 0x2015 || // ―
    cp === 0x2025 || // ‥
    cp === 0x2026 || // …
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** True when a code point belongs to Japanese/Chinese script or CJK punctuation (for §2.2 CJK-share & §2.4 join guard). */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff01 && cp <= 0xffdc) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** True when `g` is CJK (kana, Han, or CJK punctuation — incl. `…`/`‥`/`—`/`―`) for §2.4 orphan join guard. */
function isCjkJoinableGrapheme(g: string): boolean {
  const cp = g.codePointAt(0);
  if (cp === undefined) return false;
  return isCjkCodePoint(cp) || cp === 0x2014 || cp === 0x2015 || cp === 0x2025 || cp === 0x2026;
}

/** Advance width of a single grapheme cluster in `em` (§2.2). */
function glyphEm(g: string): number {
  if (g === '\n' || g === '\r' || g === '\r\n') return 0;
  const cp = g.codePointAt(0);
  if (cp === undefined) return 0;
  const ch = String.fromCodePoint(cp);
  if (isZeroWidthCodePoint(cp, ch)) return 0;
  if (cp >= 0xff61 && cp <= 0xffdc) return 0.5;
  if (isEastAsianWide(cp)) return 1.0;
  if (cp === 0x20 || cp === 0xa0) return 0.28;
  if (NARROW_ASCII.has(ch)) return 0.32;
  if (WIDE_ASCII.has(ch)) return 0.9;
  if (cp >= 0x41 && cp <= 0x5a) return 0.72;
  if (cp >= 0x30 && cp <= 0x39) return 0.6;
  return 0.56;
}

/** Advance width of `text` in em under the model of §2.2 (`'\n'` = 0). */
export function measureSubtitleEm(text: string): number {
  if (text.length === 0) return 0;
  let total = 0;
  for (const g of segmentGraphemes(text)) {
    total += glyphEm(g.text);
  }
  return total;
}

function firstCharOf(g: string): string {
  const cp = g.codePointAt(0);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function isSpaceGrapheme(g: string): boolean {
  return g === ' ' || g === '\u3000' || g === '\t' || g === '\u00a0';
}

/** Katakana run character (incl. `ー`, halfwidth katakana; excludes `・` and `゠`). */
function isKatakanaRunChar(g: string): boolean {
  const cp = g.codePointAt(0);
  if (cp === undefined) return false;
  if (cp === 0x30fb || cp === 0x30a0) return false;
  return (
    (cp >= 0x30a1 && cp <= 0x30fa) ||
    (cp >= 0x30fc && cp <= 0x30fe) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff66 && cp <= 0xff9f)
  );
}

function isKanjiOrCounterChar(g: string): boolean {
  const ch = firstCharOf(g);
  return isKanji(ch) || ch === 'ヵ';
}

function hasJapaneseKana(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x30fb || cp === 0x30a0) continue;
    if (
      (cp >= 0x3041 && cp <= 0x309f) ||
      (cp >= 0x30a1 && cp <= 0x30ff) ||
      (cp >= 0x31f0 && cp <= 0x31ff) ||
      (cp >= 0xff66 && cp <= 0xff9f)
    ) {
      return true;
    }
  }
  return false;
}

function detectLanguage(text: string): 'ja' | 'zh' | 'en' {
  if (hasJapaneseKana(text)) return 'ja';
  if (HAN_RE.test(text)) return 'zh';
  return 'en';
}

let cachedSegmenterCtor: unknown;
const wordSegmenters = new Map<string, Intl.Segmenter | null>();

function getWordSegmenter(lang: 'ja' | 'zh' | 'en'): Intl.Segmenter | null {
  const ctor = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? Intl.Segmenter : null;
  if (ctor !== cachedSegmenterCtor) {
    cachedSegmenterCtor = ctor;
    wordSegmenters.clear();
  }
  if (!ctor) return null;
  const existing = wordSegmenters.get(lang);
  if (existing !== undefined) return existing;
  const created = new ctor(lang, { granularity: 'word' });
  wordSegmenters.set(lang, created);
  return created;
}

interface ParaGrapheme {
  readonly text: string;
  readonly localStart: number;
  readonly localEnd: number;
  readonly origStart: number;
  readonly origEnd: number;
  readonly em: number;
  readonly isCjk: boolean;
}

interface Paragraph {
  readonly text: string;
  readonly graphemes: readonly ParaGrapheme[];
}

function buildParagraphFromSlice(source: string, sliceStart: number, sliceEnd: number): Paragraph {
  const sub = source.slice(sliceStart, sliceEnd);
  const graphemes: ParaGrapheme[] = segmentGraphemes(sub).map((g) => {
    const em = glyphEm(g.text);
    const cp = g.text.codePointAt(0);
    return {
      text: g.text,
      localStart: g.start,
      localEnd: g.end,
      origStart: sliceStart + g.start,
      origEnd: sliceStart + g.end,
      em,
      isCjk: cp !== undefined && isCjkCodePoint(cp),
    };
  });
  return { text: sub, graphemes };
}

function buildJoinedParagraph(l0: Paragraph, l1: Paragraph): Paragraph {
  const shift = l0.text.length;
  const graphemes: ParaGrapheme[] = [
    ...l0.graphemes,
    ...l1.graphemes.map((g) => ({
      ...g,
      localStart: shift + g.localStart,
      localEnd: shift + g.localEnd,
    })),
  ];
  return { text: l0.text + l1.text, graphemes };
}

function isInsideRubySegment(origOffset: number, rubySpans: readonly CharSpan[]): boolean {
  for (const span of rubySpans) {
    if (span[0] < origOffset && origOffset < span[1]) return true;
  }
  return false;
}

function tierCostForJa(
  paraText: string,
  G: readonly ParaGrapheme[],
  p: number,
  segKnown: boolean,
  segAtP: boolean,
): number {
  const prev = G[p - 1]!.text;
  const curr = G[p]!.text;
  const prevFirst = firstCharOf(prev);
  const currFirst = firstCharOf(curr);

  // Tier 1: clause punctuation or whitespace.
  if (JA_CLAUSE_PREV.has(prev) || JA_CLAUSE_PREV.has(prevFirst) || isSpaceGrapheme(prev) || isSpaceGrapheme(curr)) {
    return 0;
  }

  // Tier 2: bunsetsu / phrase particle boundary.
  const localOff = G[p]!.localStart;
  const before = paraText.slice(0, localOff);
  if (
    JA_BUNSETSU_TAIL_RE.test(before) &&
    !JA_DEMONSTRATIVE_TAIL_RE.test(before) &&
    (isKanjiOrCounterChar(curr) ||
      isKatakana(currFirst) ||
      OPENERS.test(curr) ||
      DIGIT_RE.test(currFirst) ||
      LATIN_LETTER_RE.test(currFirst)) &&
    (segKnown ? segAtP : true)
  ) {
    return 1;
  }

  // Tier 3: word segmenter boundary (any script, incl. kana→kana).
  if (segKnown && segAtP) {
    return 3.5;
  }

  // Tier 4: segmenter unavailable & not kanji→kanji, kanji→hiragana, or kana→kana.
  if (!segKnown) {
    const prevKanji = isKanjiOrCounterChar(prev);
    const currKanji = isKanjiOrCounterChar(curr);
    const currHira = isHiragana(currFirst);
    const prevKana = isKana(prevFirst) || prevFirst === 'ー';
    const currKana = isKana(currFirst) || currFirst === 'ー';
    if (!(prevKanji && currKanji) && !(prevKanji && currHira) && !(prevKana && currKana)) {
      return 8;
    }
  }

  // Tier 4b: last resort (inside a segmenter token, or kanji/okurigana/kana run without segmenter).
  return 12;
}

function tierCostForZh(
  paraText: string,
  G: readonly ParaGrapheme[],
  p: number,
  segKnown: boolean,
  segAtP: boolean,
): number {
  const prev = G[p - 1]!.text;
  const prevFirst = firstCharOf(prev);
  const curr = G[p]!.text;
  const currFirst = firstCharOf(curr);

  // Tier 1: clause punctuation or space.
  if (ZH_CLAUSE_PREV.has(prev) || ZH_CLAUSE_PREV.has(prevFirst) || isSpaceGrapheme(prev) || isSpaceGrapheme(curr)) {
    return 0;
  }

  // Tier 2: modal particle before break or conjunction starting next phrase.
  const localOff = G[p]!.localStart;
  const next1 = paraText.slice(localOff, localOff + 1);
  const next2 = paraText.slice(localOff, localOff + 2);
  if (
    (ZH_PARTICLES.has(prevFirst) || ZH_CONJ_1.has(next1) || ZH_CONJ_2.has(next2)) &&
    (segKnown ? segAtP : true)
  ) {
    return 1;
  }

  // Tier 3: word segmenter boundary.
  if (segKnown && segAtP) {
    return 3.5;
  }

  // Tier 4: segmenter unavailable, Han→Han.
  if (!segKnown && isKanjiOrCounterChar(prev) && isKanjiOrCounterChar(curr)) {
    return 8;
  }

  // Tier 4b: inside a token.
  return 12;
}

/**
 * Optimise a single paragraph into grapheme break indices `0 < b_1 < ... < n`.
 * Returns `[]` when no breaks should be added.
 */
function optimiseParagraph(
  para: Paragraph,
  maxLineEm: number,
  lang: 'ja' | 'zh' | 'en',
  paraMaxLines: number,
  rubySpans: readonly CharSpan[],
): number[] {
  const G = para.graphemes;
  const n = G.length;
  if (n <= 1 || paraMaxLines <= 1) return [];

  // Prefix em sums & CJK share (§2.2).
  const prefixEm = new Float64Array(n + 1);
  let cjkEm = 0;
  let nonSpaceEm = 0;
  for (let i = 0; i < n; i++) {
    const g = G[i]!;
    prefixEm[i + 1] = prefixEm[i]! + g.em;
    if (g.isCjk) cjkEm += g.em;
    if (!isSpaceGrapheme(g.text)) nonSpaceEm += g.em;
  }

  // Trailing spaces hang under pre-wrap (§2.3: 0 em).
  const trimmedEnd = new Int32Array(n + 1);
  for (let b = 0; b <= n; b++) {
    let t = b;
    while (t > 0 && isSpaceGrapheme(G[t - 1]!.text)) t--;
    trimmedEnd[b] = t;
  }

  const lineEm = (a: number, b: number): number => {
    const t = Math.max(a, trimmedEnd[b]!);
    return prefixEm[t]! - prefixEm[a]!;
  };
  const lineGraphemeCount = (a: number, b: number): number => {
    const t = Math.max(a, trimmedEnd[b]!);
    return t - a;
  };

  const T = lineEm(0, n);
  if (T <= 0) return [];
  if (cjkEm / prefixEm[n]! < 0.5) return [];
  if (T <= maxLineEm) return [];

  // Word segmenter boundaries (keyed by local UTF-16 start offset).
  const wordSeg = getWordSegmenter(lang);
  const segKnown = wordSeg !== null;
  const wordTokenLenByStart = new Map<number, number>();
  if (wordSeg) {
    for (const s of wordSeg.segment(para.text)) {
      wordTokenLenByStart.set(s.index, s.segment.length);
    }
  }

  // Precompute hard constraints 1–4 & tier costs at every internal boundary p in [1, n-1].
  const canBreak = new Uint8Array(n);
  const tierCosts = new Float64Array(n);

  for (let p = 1; p < n; p++) {
    const prevG = G[p - 1]!;
    const currG = G[p]!;
    const prev = prevG.text;
    const curr = currG.text;
    const prevFirst = firstCharOf(prev);
    const currFirst = firstCharOf(curr);

    // 1. Never split inside a RubySegment that has ruby.
    if (isInsideRubySegment(currG.origStart, rubySpans)) continue;

    // 4. Never break before whitespace (collapse consecutive spaces to a single break AFTER the spaces).
    if (isSpaceGrapheme(curr)) continue;

    // 2. Kinsoku start / end.
    if (KINSOKU_START.has(curr) || KINSOKU_START.has(currFirst)) continue;
    if (KINSOKU_END.has(prev) || KINSOKU_END.has(prevFirst)) continue;

    // 3a. Contiguous Katakana run (incl. `ー`).
    if (isKatakanaRunChar(prev) && isKatakanaRunChar(curr)) continue;

    // 3b-ascii. ASCII word (`[A-Za-z0-9'’]`).
    if (ASCII_WORD_CHAR_RE.test(prevFirst) && ASCII_WORD_CHAR_RE.test(currFirst)) continue;

    // 3c. Inside a number (`digit [.,] digit`).
    if (DIGIT_RE.test(prevFirst) && NUMBER_SEP_RE.test(currFirst) && p + 1 < n && DIGIT_RE.test(firstCharOf(G[p + 1]!.text))) {
      continue;
    }
    if (NUMBER_SEP_RE.test(prevFirst) && DIGIT_RE.test(currFirst) && p >= 2 && DIGIT_RE.test(firstCharOf(G[p - 2]!.text))) {
      continue;
    }

    // 3d. Digit followed by kanji/katakana counter (`３｜人`, `２｜キロ`).
    if (DIGIT_RE.test(prevFirst) && (isKanjiOrCounterChar(curr) || isKatakanaRunChar(curr))) continue;

    // 3e. Inside a Latin word followed by `-` (or right after intra-word `-`).
    if (LATIN_OR_DIGIT_RE.test(prevFirst) && currFirst === '-') continue;
    if (
      prevFirst === '-' &&
      (LATIN_OR_DIGIT_RE.test(currFirst) || isKatakanaRunChar(curr)) &&
      p >= 2 &&
      LATIN_OR_DIGIT_RE.test(firstCharOf(G[p - 2]!.text))
    ) {
      continue;
    }

    // 3b (ja, hard): Auxiliary attachment.
    if (lang === 'ja' && (isKana(prevFirst) || prevFirst === 'ー' || isKanjiOrCounterChar(prev))) {
      const auxMatch = JA_AUX_RE.exec(para.text.slice(currG.localStart));
      if (auxMatch) {
        const tokLen = wordSeg ? wordTokenLenByStart.get(currG.localStart) : undefined;
        if (tokLen === undefined || tokLen <= auxMatch[0].length) {
          continue;
        }
      }
    }

    canBreak[p] = 1;
    const segAtP = wordTokenLenByStart.has(currG.localStart);
    tierCosts[p] =
      lang === 'ja'
        ? tierCostForJa(para.text, G, p, segKnown, segAtP)
        : lang === 'zh'
          ? tierCostForZh(para.text, G, p, segKnown, segAtP)
          : isSpaceGrapheme(prev)
            ? 0
            : segKnown && segAtP
              ? 3.5
              : 12;
  }

  // Constraint 5 & 6 feasibility for a single line [a, b).
  const enforceMinLine = T >= 6;
  const minLineEm = enforceMinLine ? Math.max(2.5, 0.2 * T) : 0;
  const minGraphemes = enforceMinLine ? 3 : n >= 4 ? 2 : 1;

  const isLineFeasible = (a: number, b: number): boolean => {
    const count = lineGraphemeCount(a, b);
    if (count < minGraphemes) return false;
    const w = lineEm(a, b);
    if (enforceMinLine && w + 1e-9 < minLineEm) return false;
    if (w - 1e-9 > maxLineEm) return false;
    return true;
  };

  // §2.6 DP over k in ceil(nonSpaceEm / maxLineEm) .. paraMaxLines
  // (using nonSpaceEm as the lower bound allows trailing spaces at a break to hang at 0 em).
  const minK = Math.max(2, Math.ceil((nonSpaceEm - 1e-9) / maxLineEm));
  for (let k = minK; k <= paraMaxLines; k++) {
    const mu = T / k;
    // bestCost[j * (n + 1) + i] = min cost to lay [0, i) into j lines (j in 1..k).
    const stride = n + 1;
    const bestCost = new Float64Array((k + 1) * stride);
    bestCost.fill(Infinity);
    const parent = new Int32Array((k + 1) * stride);
    parent.fill(-1);

    // Base case j = 1: first line [0, i) ending at i (if j < k, i must be an allowed break; if k === 1, i === n).
    for (let i = 1; i < n; i++) {
      if (!canBreak[i]) continue;
      if (!isLineFeasible(0, i)) continue;
      const w = lineEm(0, i);
      bestCost[1 * stride + i] = 0.35 * (w - mu) * (w - mu) + tierCosts[i]!;
      parent[1 * stride + i] = 0;
    }

    // Transitions j = 2 .. k - 1 (intermediate lines ending with a break at i).
    for (let j = 2; j < k; j++) {
      const prevRow = (j - 1) * stride;
      const currRow = j * stride;
      for (let prev = j - 1; prev < n; prev++) {
        const baseCost = bestCost[prevRow + prev]!;
        if (!Number.isFinite(baseCost)) continue;
        for (let i = prev + 1; i < n; i++) {
          if (!canBreak[i]) continue;
          if (!isLineFeasible(prev, i)) continue;
          const w = lineEm(prev, i);
          const c = baseCost + 0.35 * (w - mu) * (w - mu) + tierCosts[i]!;
          if (c < bestCost[currRow + i]!) {
            bestCost[currRow + i] = c;
            parent[currRow + i] = prev;
          }
        }
      }
    }

    // Final line j = k: [prev, n) — no trailing break cost at n.
    const lastPrevRow = (k - 1) * stride;
    let bestFinal = Infinity;
    let bestPrev = -1;
    for (let prev = k - 1; prev < n; prev++) {
      const baseCost = bestCost[lastPrevRow + prev]!;
      if (!Number.isFinite(baseCost)) continue;
      if (!isLineFeasible(prev, n)) continue;
      const w = lineEm(prev, n);
      const c = baseCost + 0.35 * (w - mu) * (w - mu);
      if (c < bestFinal) {
        bestFinal = c;
        bestPrev = prev;
      }
    }

    if (bestPrev !== -1 && Number.isFinite(bestFinal)) {
      const breaks: number[] = [];
      let cur = bestPrev;
      for (let j = k - 1; j >= 1; j--) {
        breaks.push(cur);
        cur = parent[j * stride + cur]!;
      }
      breaks.reverse();
      return breaks;
    }
  }

  // Fallback A: greedy kinsoku-safe fill (constraints 1–4 and 6 only) when T > paraMaxLines * maxLineEm.
  if (T > paraMaxLines * maxLineEm + 1e-9) {
    const greedy: number[] = [];
    let start = 0;
    while (lineEm(start, n) > maxLineEm + 1e-9) {
      let bestP = -1;
      for (let p = start + 1; p < n; p++) {
        if (lineEm(start, p) > maxLineEm + 1e-9) break;
        if (canBreak[p]) bestP = p;
      }
      if (bestP === -1) {
        // Unsplittable run exceeds maxLineEm: advance to the first legal boundary after it.
        for (let p = start + 1; p < n; p++) {
          if (canBreak[p]) {
            bestP = p;
            break;
          }
        }
      }
      if (bestP === -1) break;
      greedy.push(bestP);
      start = bestP;
    }
    return greedy;
  }

  // Fallback B: empty plan (browser wraps as today).
  return [];
}

function minResultingLineEm(para: Paragraph, breakIndices: readonly number[]): number {
  const G = para.graphemes;
  const n = G.length;
  let minW = Infinity;
  let start = 0;
  for (let idx = 0; idx <= breakIndices.length; idx++) {
    const end = idx < breakIndices.length ? breakIndices[idx]! : n;
    let t = end;
    while (t > start && isSpaceGrapheme(G[t - 1]!.text)) t--;
    let w = 0;
    for (let i = start; i < t; i++) w += G[i]!.em;
    if (w < minW) minW = w;
    start = end;
  }
  return minW;
}

const LRU_CAPACITY = 64;
const planCache = new Map<string, LineBreakPlan>();

/** Break plan for one subtitle (may contain `'\n'`). Empty sets when it already fits. */
export function computeBalancedBreakOffsets(
  text: string,
  maxLineEm: number,
  opts?: LineBalanceOptions,
): LineBreakPlan {
  if (!Number.isFinite(maxLineEm) || maxLineEm <= 0 || text.length === 0) {
    return EMPTY_PLAN;
  }

  const maxLines = opts?.maxLines ?? 3;
  if (maxLines < 1) return EMPTY_PLAN;

  const langOpt = opts?.lang ?? '';
  const segKey = opts?.segments
    ? opts.segments.map((s) => `${s.charSpan[0]}:${s.charSpan[1]}:${s.ruby ? 1 : 0}`).join(',')
    : '';
  const segAvail = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? '1' : '0';
  const cacheKey = `${maxLineEm}|${langOpt}|${maxLines}|${segAvail}|${segKey}|${text}`;

  const hit = planCache.get(cacheKey);
  if (hit !== undefined) {
    planCache.delete(cacheKey);
    planCache.set(cacheKey, hit);
    return hit;
  }

  const lang = opts?.lang ?? detectLanguage(text);
  const rubySpans: CharSpan[] = [];
  if (opts?.segments) {
    for (const s of opts.segments) {
      if (s.ruby && s.ruby.length > 0 && s.charSpan[1] > s.charSpan[0]) {
        rubySpans.push(s.charSpan);
      }
    }
  }

  // Split text on '\n' into hard lines while tracking exact UTF-16 offsets.
  const hardSlices: Array<{ start: number; end: number }> = [];
  const nlOffsets: number[] = [];
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      hardSlices.push({ start: lineStart, end: i });
      nlOffsets.push(i);
      lineStart = i + 1;
    }
  }
  hardSlices.push({ start: lineStart, end: text.length });

  const softBreaks = new Set<number>();
  const joinedHardBreaks = new Set<number>();

  // §2.4 Orphan re-flow candidate when m === 2 (exactly one '\n').
  let handledViaJoin = false;
  if (hardSlices.length === 2) {
    const s0 = hardSlices[0]!;
    const s1 = hardSlices[1]!;
    const p0 = buildParagraphFromSlice(text, s0.start, s0.end);
    const p1 = buildParagraphFromSlice(text, s1.start, s1.end);

    if (p0.graphemes.length > 0 && p1.graphemes.length > 0) {
      let orphanEm = 0;
      for (const g of p1.graphemes) orphanEm += g.em;
      const isOrphan = p1.graphemes.length <= 2 || orphanEm <= 2.5;
      const lastG0 = p0.graphemes[p0.graphemes.length - 1]!;
      const firstG1 = p1.graphemes[0]!;
      const startsWithWs = /^\s/u.test(p1.text) || p1.text.startsWith('\u3000');

      if (
        isOrphan &&
        !TERMINAL_PUNCTUATION.test(p0.text) &&
        !OPENERS.test(p1.text) &&
        !startsWithWs &&
        isCjkJoinableGrapheme(lastG0.text) &&
        isCjkJoinableGrapheme(firstG1.text)
      ) {
        const joined = buildJoinedParagraph(p0, p1);
        let joinedTotalEm = 0;
        let joinedCjkEm = 0;
        for (const g of joined.graphemes) {
          joinedTotalEm += g.em;
          if (g.isCjk) joinedCjkEm += g.em;
        }
        const nlOff = nlOffsets[0]!;
        if (joinedTotalEm <= maxLineEm) {
          joinedHardBreaks.add(nlOff);
          handledViaJoin = true;
        } else if (joinedTotalEm > 0 && joinedCjkEm / joinedTotalEm >= 0.5) {
          const breaks = optimiseParagraph(joined, maxLineEm, lang, maxLines, rubySpans);
          const sameAsOriginalNl =
            breaks.length === 1 && joined.graphemes[breaks[0]!]!.origStart === s1.start;
          if (breaks.length > 0 && !sameAsOriginalNl && minResultingLineEm(joined, breaks) + 1e-9 >= orphanEm) {
            joinedHardBreaks.add(nlOff);
            for (const bIdx of breaks) {
              softBreaks.add(joined.graphemes[bIdx]!.origStart);
            }
            handledViaJoin = true;
          }
        }
      }
    }
  }

  if (!handledViaJoin) {
    const m = hardSlices.length;
    const paraMaxLines = Math.max(1, maxLines - (m - 1));
    for (const slice of hardSlices) {
      if (slice.end <= slice.start) continue;
      const para = buildParagraphFromSlice(text, slice.start, slice.end);
      const breaks = optimiseParagraph(para, maxLineEm, lang, paraMaxLines, rubySpans);
      for (const bIdx of breaks) {
        softBreaks.add(para.graphemes[bIdx]!.origStart);
      }
    }
  }

  const plan: LineBreakPlan =
    softBreaks.size === 0 && joinedHardBreaks.size === 0
      ? EMPTY_PLAN
      : { softBreaks, joinedHardBreaks };

  if (planCache.size >= LRU_CAPACITY) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
  planCache.set(cacheKey, plan);
  return plan;
}

/** String form for non-ruby lines: inserts `'\n'` at `softBreaks` and drops `joinedHardBreaks`. */
export function balanceSubtitleLines(
  text: string,
  maxLineEm: number,
  opts?: LineBalanceOptions,
): string {
  const plan = computeBalancedBreakOffsets(text, maxLineEm, opts);
  if (plan.softBreaks.size === 0 && plan.joinedHardBreaks.size === 0) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (plan.softBreaks.has(i)) out += '\n';
    if (plan.joinedHardBreaks.has(i)) continue;
    out += text[i]!;
  }
  return out;
}
