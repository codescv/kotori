/**
 * Reader layout: groups pages into `MangaSpread`s for the active reading mode.
 */
import type { MangaReadingMode, MangaSpread, MangaSpreadSlot } from '../types';

/** Minimal page info needed for layout. */
export interface SpreadPageInfo {
  readonly index: number;
  readonly width: number;
  readonly height: number;
}

/** Options for {@link buildSpreads}. */
export interface BuildSpreadsOptions {
  readonly mode: MangaReadingMode;
  /** Show the first page alone in spread modes. */
  readonly coverIsSingle: boolean;
}

const BLANK: MangaSpreadSlot = { kind: 'blank' };
const slot = (pageIndex: number): MangaSpreadSlot => ({ kind: 'page', pageIndex });

/**
 * Group pages into spreads.
 *
 * - `single-rtl` / `single-ltr` / `webtoon`: one spread per page.
 * - `spread-rtl` / `spread-ltr`: pages are paired in order; the cover (first
 *   page, when `coverIsSingle`) and wide pages (`width > height`) sit alone.
 *   In RTL the first page of a pair goes `right`, in LTR `left`.
 *
 * A page that sits alone occupies the leading slot (`right` in RTL modes,
 * `left` otherwise) with a `blank` in the other. `pageIndexes` lists pages in
 * reading order. Input order is preserved; slots carry each page's `index`.
 */
export function buildSpreads(pages: readonly SpreadPageInfo[], opts: BuildSpreadsOptions): MangaSpread[] {
  const rtl = opts.mode === 'single-rtl' || opts.mode === 'spread-rtl';
  const paired = opts.mode === 'spread-rtl' || opts.mode === 'spread-ltr';
  const isWide = (p: SpreadPageInfo): boolean => p.width > p.height;
  const spreads: MangaSpread[] = [];
  const push = (first: SpreadPageInfo, second?: SpreadPageInfo): void => {
    const a = slot(first.index);
    const b = second ? slot(second.index) : BLANK;
    spreads.push({
      index: spreads.length,
      left: rtl ? b : a,
      right: rtl ? a : b,
      pageIndexes: second ? [first.index, second.index] : [first.index],
    });
  };
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] as SpreadPageInfo;
    const next = pages[i + 1];
    const alone = !paired || (i === 0 && opts.coverIsSingle) || isWide(page) || !next || isWide(next);
    if (alone) {
      push(page);
    } else {
      push(page, next);
      i++;
    }
  }
  return spreads;
}

/** Index of the spread containing page `pageIndex`, or `-1` when no spread contains it. */
export function spreadIndexForPage(spreads: readonly MangaSpread[], pageIndex: number): number {
  return spreads.findIndex((s) => s.pageIndexes.includes(pageIndex));
}
