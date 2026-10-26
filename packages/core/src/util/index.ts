/**
 * @kotori/core/util — tiny platform-neutral helpers.
 *
 * Owner: coder-1. Modules (see ARCHITECTURE.md §4.5):
 *   - errors.ts     KotoriError
 *   - hash.ts       fnv1a64(str) + sha256Hex(str) via WebCrypto `crypto.subtle`
 *   - graphemes.ts  splitGraphemes(str) via Intl.Segmenter, graphemeCount()
 *   - text.ts       normaliseJapanese (NFKC-lite for JP), isKanji/isKana, katakanaToHiragana
 *   - time.ts       formatClock(ms) → `m:ss` / `h:mm:ss`, parseClock
 *   - natural-sort.ts compareNatural(a, b) for page/episode file names
 */
export * from './errors';
export * from './hash';
export * from './graphemes';
export * from './text';
export * from './time';
export * from './natural-sort';
