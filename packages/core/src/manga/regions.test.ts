import { describe, expect, it } from 'vitest';
import type { MangaBlock, MangaPoint } from '../types';
import { deriveCharRegions } from './regions';

function block(overrides: Partial<MangaBlock> & Pick<MangaBlock, 'lines'>): MangaBlock {
  return {
    index: 0,
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
    vertical: false,
    fontSize: 20,
    zIndex: 0,
    text: overrides.lines.join(''),
    source: 'mokuro',
    ...overrides,
  };
}

const centre = (r: { left: number; top: number; right: number; bottom: number }): [number, number] => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];

describe('deriveCharRegions', () => {
  it('returns producer regions verbatim when present', () => {
    const regions = [{ rect: { left: 1, top: 2, right: 3, bottom: 4 }, utf16Start: 0, utf16End: 1 }];
    expect(deriveCharRegions(block({ lines: ['あ'], regions }))).toEqual(regions);
  });

  it('splits vertical lines_coords columns top→bottom per grapheme with UTF-16 offsets', () => {
    const b = block({
      vertical: true,
      rect: { left: 0, top: 0, right: 100, bottom: 300 },
      lines: ['あい', '𠮷'],
      linesCoords: [
        [
          [50, 0],
          [100, 0],
          [100, 200],
          [50, 200],
        ],
        [
          [0, 0],
          [50, 0],
          [50, 100],
          [0, 100],
        ],
      ],
    });
    const r = deriveCharRegions(b);
    expect(r).toEqual([
      { rect: { left: 50, top: 0, right: 100, bottom: 100 }, utf16Start: 0, utf16End: 1 },
      { rect: { left: 50, top: 100, right: 100, bottom: 200 }, utf16Start: 1, utf16End: 2 },
      // Surrogate pair: one cell spanning two UTF-16 units.
      { rect: { left: 0, top: 0, right: 50, bottom: 100 }, utf16Start: 2, utf16End: 4 },
    ]);
  });

  it('falls back to splitting the block rect: vertical columns right→left', () => {
    const r = deriveCharRegions(block({ vertical: true, lines: ['ab', 'c'] }));
    expect(r.map((x) => x.rect)).toEqual([
      { left: 50, top: 0, right: 100, bottom: 50 },
      { left: 50, top: 50, right: 100, bottom: 100 },
      { left: 0, top: 0, right: 50, bottom: 100 },
    ]);
  });

  it('falls back to splitting the block rect: horizontal rows top→bottom, cells left→right, skipping whitespace', () => {
    const r = deriveCharRegions(block({ lines: ['a b', 'cd'] }));
    expect(r).toEqual([
      { rect: { left: 0, top: 0, right: 50, bottom: 50 }, utf16Start: 0, utf16End: 1 },
      { rect: { left: 50, top: 0, right: 100, bottom: 50 }, utf16Start: 2, utf16End: 3 },
      { rect: { left: 0, top: 50, right: 50, bottom: 100 }, utf16Start: 3, utf16End: 4 },
      { rect: { left: 50, top: 50, right: 100, bottom: 100 }, utf16Start: 4, utf16End: 5 },
    ]);
  });

  it('uses the bounding box of non-quad polygons and ignores mismatched lines_coords', () => {
    const poly: MangaPoint[] = [
      [10, 10],
      [30, 5],
      [30, 50],
      [20, 60],
      [10, 50],
    ];
    const r = deriveCharRegions(block({ vertical: true, lines: ['ab'], linesCoords: [poly] }));
    expect(r.map((x) => x.rect)).toEqual([
      { left: 10, top: 5, right: 30, bottom: 32.5 },
      { left: 10, top: 32.5, right: 30, bottom: 60 },
    ]);
    // Two coords for one line → block-rect fallback.
    const fallback = deriveCharRegions(block({ lines: ['ab'], linesCoords: [poly, poly] }));
    expect(fallback[0]!.rect).toEqual({ left: 0, top: 0, right: 50, bottom: 100 });
  });

  it('lays cells along a tilted 4-point quad and records the rotation', () => {
    // Horizontal line 200×40 centred at (200, 200), rotated 30° clockwise.
    const angle = Math.PI / 6;
    const [cx, cy, w, h] = [200, 200, 200, 40];
    const corner = (lx: number, ly: number): MangaPoint => [cx + lx * Math.cos(angle) - ly * Math.sin(angle), cy + lx * Math.sin(angle) + ly * Math.cos(angle)];
    const quad = [corner(-w / 2, -h / 2), corner(w / 2, -h / 2), corner(w / 2, h / 2), corner(-w / 2, h / 2)];
    const r = deriveCharRegions(block({ rect: { left: 0, top: 0, right: 400, bottom: 400 }, lines: ['abcd'], linesCoords: [quad] }));
    expect(r).toHaveLength(4);
    for (const [i, cell] of r.entries()) {
      expect(cell.rotation).toBeCloseTo(angle, 6);
      expect(cell.rect.right - cell.rect.left).toBeCloseTo(50, 6);
      expect(cell.rect.bottom - cell.rect.top).toBeCloseTo(40, 6);
      const [x, y] = centre(cell.rect);
      const [ex, ey] = corner(-w / 2 + (i + 0.5) * 50, 0);
      expect(x).toBeCloseTo(ex, 6);
      expect(y).toBeCloseTo(ey, 6);
    }
  });

  it('treats a negligibly tilted quad as upright', () => {
    const r = deriveCharRegions(
      block({
        lines: ['ab'],
        linesCoords: [
          [
            [0, 0],
            [40, 0.2],
            [40, 20.2],
            [0, 20],
          ],
        ],
      }),
    );
    expect(r.every((c) => c.rotation === undefined)).toBe(true);
  });

  it('returns [] for empty lines or an empty rect', () => {
    expect(deriveCharRegions(block({ lines: [] }))).toEqual([]);
    expect(deriveCharRegions(block({ lines: ['a'], rect: { left: 0, top: 0, right: 0, bottom: 0 } }))).toEqual([]);
  });
});
