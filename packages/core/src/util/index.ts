/**
 * @kotori/core/util — tiny platform-neutral helpers.
 *
 * Owner: coder-1. Planned modules (see ARCHITECTURE.md §4.6):
 *   - errors.ts     KotoriError (done, scaffold)
 *   - hash.ts       fnv1a64(str) + sha256Hex(str) via WebCrypto `crypto.subtle`
 *   - graphemes.ts  splitGraphemes(str) via Intl.Segmenter, graphemeCount()
 *   - text.ts       normaliseWidth (NFKC-lite for JP), stripWhitespace, isKanji/isKana
 *   - time.ts       formatClock(ms) → `m:ss` / `h:mm:ss`, parseClock
 *   - natural-sort.ts compareNatural(a, b) for page/episode file names
 */
export * from './errors';
