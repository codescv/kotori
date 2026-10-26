/**
 * Japanese text helpers used by span alignment, ruby segmentation and name
 * parsers. All functions are pure.
 */

/** CJK ideograph test (incl. ext. A, compatibility ideographs, `々`, `〆`, `ヶ`). */
export function isKanji(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2ebef) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    cp === 0x3005 || // 々
    cp === 0x3006 || // 〆
    cp === 0x30f6 || // ヶ
    cp === 0x3007 // 〇
  );
}

/** Hiragana (U+3041–U+309F) test. */
export function isHiragana(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && cp >= 0x3041 && cp <= 0x309f;
}

/** Katakana (U+30A0–U+30FF, half-width U+FF66–U+FF9F, phonetic ext.) test. */
export function isKatakana(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && ((cp >= 0x30a0 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff66 && cp <= 0xff9f));
}

/** Kana (hiragana or katakana, incl. `ー`) test. `ヶ` counts as kanji-like, not kana. */
export function isKana(ch: string): boolean {
  if (ch === 'ヶ') return false;
  return isHiragana(ch) || isKatakana(ch);
}

/** Convert full-width katakana (ァ–ヶ, ヽヾ) to hiragana; other chars unchanged. */
export function katakanaToHiragana(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x30a1 && cp <= 0x30f6) || cp === 0x30fd || cp === 0x30fe) out += String.fromCodePoint(cp - 0x60);
    else out += ch;
  }
  return out;
}

/** Whitespace incl. ideographic space. */
export function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch) || ch === '\u3000';
}

/** Characters folded away by `normaliseJapanese` (long-vowel marks / wave dashes are mapped, not removed). */
const LONG_VOWEL = /[ーｰ―‐−-]/u;
const WAVE = /[～〜~]/u;

/**
 * Normalise one already-NFKC'd character for fuzzy comparison. Returns `''`
 * when the character should be dropped (whitespace).
 */
function foldChar(ch: string): string {
  if (isWhitespace(ch)) return '';
  if (WAVE.test(ch)) return '〜';
  if (LONG_VOWEL.test(ch)) return 'ー';
  return katakanaToHiragana(ch).toLowerCase();
}

/**
 * Fuzzy-comparison normal form for Japanese text: NFKC, strip whitespace
 * (incl. `　`), unify `～`/`〜`/`~`, unify long-vowel/dash marks to `ー`,
 * katakana → hiragana, lower-case Latin.
 */
export function normaliseJapanese(text: string): string {
  return normaliseJapaneseWithMap(text).text;
}

/**
 * Same as `normaliseJapanese` but also returns, for every UTF-16 unit of the
 * normalised string, the UTF-16 offset in the source where it originated
 * (`map[i]`), plus `map[text.length] = source.length` as a sentinel. Used by
 * `alignSpans` to project fuzzy matches back to original offsets.
 */
export function normaliseJapaneseWithMap(source: string): { text: string; map: number[]; endMap: number[] } {
  let text = '';
  const map: number[] = [];
  const endMap: number[] = [];
  let i = 0;
  for (const ch of source) {
    const start = i;
    i += ch.length;
    const folded = [...ch.normalize('NFKC')].map(foldChar).join('');
    for (let k = 0; k < folded.length; k++) {
      map.push(start);
      endMap.push(i);
    }
    text += folded;
  }
  map.push(source.length);
  endMap.push(source.length);
  return { text, map, endMap };
}

/** Terminal punctuation that ends a sentence (JP + ASCII). */
export const TERMINAL_PUNCTUATION = /[。．.!！?？…‥」』）)♪～〜]$/u;

/** Punctuation / symbol test used for click-between-chunks heuristics. */
export function isPunctuationOrSpace(ch: string): boolean {
  return isWhitespace(ch) || /[\p{P}\p{S}]/u.test(ch);
}
