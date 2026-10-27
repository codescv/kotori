import { describe, expect, it } from 'vitest';
import type { MangaBlock } from '@kotori/core';
import {
  blockAt,
  buildSpreads,
  charIndexAt,
  clientToPage,
  deriveCharRegions,
  fitWithin,
  formatMangaVolumeTitle,
  inferMangaSeriesTitle,
  normaliseDragRect,
  spreadIndexForPage,
} from './manga';

const pages = [
  { index: 0, width: 1200, height: 1700 },
  { index: 1, width: 1200, height: 1700 },
  { index: 2, width: 1200, height: 1700 },
  { index: 3, width: 2400, height: 1700 }, // wide double page
  { index: 4, width: 1200, height: 1700 },
  { index: 5, width: 1200, height: 1700 },
];

describe('buildSpreads', () => {
  it('spread-rtl: cover alone, right slot read first, wide page alone', () => {
    const s = buildSpreads(pages, { mode: 'spread-rtl', coverIsSingle: true });
    expect(s.map((x) => x.pageIndexes)).toEqual([[0], [1, 2], [3], [4, 5]]);
    expect(s[1]?.right).toEqual({ kind: 'page', pageIndex: 1 });
    expect(s[1]?.left).toEqual({ kind: 'page', pageIndex: 2 });
    expect(s[0]?.right).toEqual({ kind: 'page', pageIndex: 0 });
    expect(s[0]?.left).toEqual({ kind: 'blank' });
    expect(s.map((x) => x.index)).toEqual([0, 1, 2, 3]);
  });

  it('spread-ltr mirrors the slots', () => {
    const s = buildSpreads(pages, { mode: 'spread-ltr', coverIsSingle: true });
    expect(s[1]?.left).toEqual({ kind: 'page', pageIndex: 1 });
    expect(s[1]?.right).toEqual({ kind: 'page', pageIndex: 2 });
  });

  it('coverIsSingle=false pairs the cover; a page before a wide page sits alone', () => {
    const s = buildSpreads(pages, { mode: 'spread-rtl', coverIsSingle: false });
    expect(s.map((x) => x.pageIndexes)).toEqual([[0, 1], [2], [3], [4, 5]]);
  });

  it('single and webtoon modes yield one page per unit', () => {
    expect(buildSpreads(pages, { mode: 'single-rtl', coverIsSingle: true })).toHaveLength(6);
    expect(buildSpreads(pages, { mode: 'webtoon', coverIsSingle: false }).map((x) => x.pageIndexes)).toEqual(pages.map((p) => [p.index]));
  });

  it('spreadIndexForPage finds the unit containing a page (0 when missing)', () => {
    const s = buildSpreads(pages, { mode: 'spread-rtl', coverIsSingle: true });
    expect(spreadIndexForPage(s, 2)).toBe(1);
    expect(spreadIndexForPage(s, 3)).toBe(2);
    expect(spreadIndexForPage(s, 99)).toBe(0);
  });
});

const block = (over: Partial<MangaBlock>): MangaBlock => ({
  index: 0,
  rect: { left: 100, top: 100, right: 200, bottom: 300 },
  vertical: true,
  fontSize: 40,
  zIndex: 0,
  lines: ['あいう', 'えお'],
  text: 'あいうえお',
  source: 'mokuro',
  ...over,
});

describe('deriveCharRegions / charIndexAt', () => {
  it('vertical text: columns right→left, glyphs top→bottom', () => {
    const b = block({});
    const r = deriveCharRegions(b);
    expect(r.map((x) => x.utf16Start)).toEqual([0, 1, 2, 3, 4]);
    // first column is the right half
    expect(r[0]?.rect.left).toBe(150);
    expect(r[3]?.rect.right).toBe(150);
    expect(charIndexAt(b, 175, 110)).toBe(0);
    expect(charIndexAt(b, 175, 290)).toBe(2);
    expect(charIndexAt(b, 125, 110)).toBe(3);
    expect(charIndexAt(b, 125, 290)).toBe(4);
  });

  it('uses linesCoords and UTF-16 offsets for surrogate pairs', () => {
    const b = block({
      lines: ['𠮷野', '家'],
      text: '𠮷野家',
      linesCoords: [
        [[160, 100], [200, 100], [200, 180], [160, 180]],
        [[120, 100], [160, 100], [160, 140], [120, 140]],
      ],
    });
    const r = deriveCharRegions(b);
    expect(r.map((x) => [x.utf16Start, x.utf16End])).toEqual([[0, 2], [2, 3], [3, 4]]);
    expect(charIndexAt(b, 180, 170)).toBe(2);
    expect(charIndexAt(b, 140, 120)).toBe(3);
  });

  it('horizontal text runs left→right in rows', () => {
    const b = block({ vertical: false, rect: { left: 0, top: 0, right: 300, bottom: 100 }, lines: ['abc', 'de'], text: 'abcde' });
    expect(charIndexAt(b, 290, 10)).toBe(2);
    expect(charIndexAt(b, 10, 90)).toBe(3);
  });
});

describe('blockAt', () => {
  it('prefers higher zIndex, then the smaller area', () => {
    const big = block({ index: 0, zIndex: 0, rect: { left: 0, top: 0, right: 500, bottom: 500 } });
    const small = block({ index: 1, zIndex: 0, rect: { left: 100, top: 100, right: 200, bottom: 200 } });
    const top = block({ index: 2, zIndex: 5, rect: { left: 0, top: 0, right: 400, bottom: 400 } });
    expect(blockAt({ blocks: [big, small] }, 150, 150)?.index).toBe(1);
    expect(blockAt({ blocks: [big, small, top] }, 150, 150)?.index).toBe(2);
    expect(blockAt({ blocks: [big, small] }, 450, 450)?.index).toBe(0);
    expect(blockAt({ blocks: [small] }, 450, 450)).toBeUndefined();
  });
});

describe('geometry helpers', () => {
  it('normaliseDragRect handles any drag direction and clamps', () => {
    expect(normaliseDragRect({ x: 300, y: 50 }, { x: -20, y: 400 }, 1000, 300)).toEqual({ left: 0, top: 50, right: 300, bottom: 300 });
  });
  it('fitWithin never upscales', () => {
    expect(fitWithin(2048, 1024, 1024)).toEqual({ width: 1024, height: 512, scale: 0.5 });
    expect(fitWithin(300, 200, 1024)).toEqual({ width: 300, height: 200, scale: 1 });
  });
  it('clientToPage maps the rendered box to page pixels', () => {
    expect(clientToPage(150, 120, { left: 100, top: 20, width: 200, height: 400 }, 1200, 2400)).toEqual({ x: 300, y: 600 });
  });
  it('formatMangaVolumeTitle prioritizes work title + volume number over raw filenames', () => {
    expect(
      inferMangaSeriesTitle({
        title: '(一般コミック) [あずまきよひこ] よつばと! 第01巻 [DL版]',
        seriesTitle: undefined,
      }),
    ).toBe('よつばと!');
    expect(
      formatMangaVolumeTitle({
        title: '(一般コミック) [あずまきよひこ] よつばと! 第01巻 [DL版]',
        seriesTitle: 'よつばと!',
        volumeNumber: 1,
      }),
    ).toBe('よつばと! · 第 1 卷');
  });
});
