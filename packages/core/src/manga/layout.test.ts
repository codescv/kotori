import { describe, expect, it } from 'vitest';
import type { MangaSpread } from '../types';
import { buildSpreads, spreadIndexForPage, type SpreadPageInfo } from './layout';

const tall = (index: number): SpreadPageInfo => ({ index, width: 1000, height: 1500 });
const wide = (index: number): SpreadPageInfo => ({ index, width: 2000, height: 1500 });
const p = (pageIndex: number) => ({ kind: 'page', pageIndex }) as const;
const blank = { kind: 'blank' } as const;
const brief = (spreads: MangaSpread[]) => spreads.map((s) => s.pageIndexes);

describe('buildSpreads', () => {
  const pages = [tall(0), tall(1), tall(2), wide(3), tall(4), tall(5), tall(6)];

  it('single modes and webtoon: one spread per page', () => {
    for (const mode of ['single-rtl', 'single-ltr', 'webtoon'] as const) {
      const spreads = buildSpreads(pages, { mode, coverIsSingle: true });
      expect(brief(spreads)).toEqual(pages.map((x) => [x.index]));
      expect(spreads.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
    expect(buildSpreads([tall(0)], { mode: 'single-rtl', coverIsSingle: false })[0]).toMatchObject({ right: p(0), left: blank });
    expect(buildSpreads([tall(0)], { mode: 'single-ltr', coverIsSingle: false })[0]).toMatchObject({ left: p(0), right: blank });
  });

  it('spread-rtl: cover alone, right slot first, wide pages alone, trailing page alone', () => {
    const spreads = buildSpreads(pages, { mode: 'spread-rtl', coverIsSingle: true });
    expect(brief(spreads)).toEqual([[0], [1, 2], [3], [4, 5], [6]]);
    expect(spreads[0]).toEqual({ index: 0, right: p(0), left: blank, pageIndexes: [0] });
    expect(spreads[1]).toEqual({ index: 1, right: p(1), left: p(2), pageIndexes: [1, 2] });
    expect(spreads[2]).toMatchObject({ right: p(3), left: blank });
  });

  it('spread-ltr without cover offset pairs from page 0, left slot first', () => {
    const spreads = buildSpreads(pages, { mode: 'spread-ltr', coverIsSingle: false });
    // Page 2 cannot pair with the wide page 3, so it sits alone.
    expect(brief(spreads)).toEqual([[0, 1], [2], [3], [4, 5], [6]]);
    expect(spreads[0]).toMatchObject({ left: p(0), right: p(1) });
    expect(spreads[1]).toMatchObject({ left: p(2), right: blank });
  });

  it('handles an empty volume', () => {
    expect(buildSpreads([], { mode: 'spread-rtl', coverIsSingle: true })).toEqual([]);
  });
});

describe('spreadIndexForPage', () => {
  it('finds the spread containing a page', () => {
    const spreads = buildSpreads([tall(0), tall(1), tall(2), tall(3)], { mode: 'spread-rtl', coverIsSingle: true });
    expect(spreadIndexForPage(spreads, 0)).toBe(0);
    expect(spreadIndexForPage(spreads, 2)).toBe(1);
    expect(spreadIndexForPage(spreads, 3)).toBe(2);
    expect(spreadIndexForPage(spreads, 99)).toBe(-1);
  });
});
