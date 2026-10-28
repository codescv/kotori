import { describe, expect, it } from 'vitest';
import type { MangaBlock } from '../types';
import { sortBlocksInReadingOrder } from './regions';

const b = (id: string, x1: number, y1: number, x2: number, y2: number) => ({ id, box: [x1, y1, x2, y2] as const });

describe('sortBlocksInReadingOrder', () => {
  it('reads tiers top to bottom and right to left within a tier', () => {
    const blocks = [
      b('bottom-left', 50, 600, 250, 800),
      b('top-left', 100, 50, 300, 250),
      b('bottom-right', 600, 620, 800, 780),
      b('top-right', 700, 80, 900, 300),
      b('top-middle', 400, 60, 550, 200),
    ];
    expect(sortBlocksInReadingOrder(blocks, 1000, 1000).map((x) => x.id)).toEqual(['top-right', 'top-middle', 'top-left', 'bottom-right', 'bottom-left']);
  });

  it('stacks blocks of the same column top to bottom inside a tall tier', () => {
    const blocks = [
      b('left-lower', 100, 300, 250, 450),
      b('tall-right', 700, 0, 850, 500),
      b('left-upper', 120, 20, 260, 200),
    ];
    expect(sortBlocksInReadingOrder(blocks).map((x) => x.id)).toEqual(['tall-right', 'left-upper', 'left-lower']);
  });

  it('accepts MangaBlock rects and does not mutate the input', () => {
    const mk = (index: number, left: number, top: number): MangaBlock => ({
      index,
      rect: { left, top, right: left + 100, bottom: top + 100 },
      vertical: true,
      fontSize: 20,
      zIndex: index,
      lines: [String(index)],
      text: String(index),
      source: 'mokuro',
    });
    const input = [mk(0, 0, 0), mk(1, 500, 0), mk(2, 500, 400)];
    const out = sortBlocksInReadingOrder(input);
    expect(out.map((x) => x.index)).toEqual([1, 0, 2]);
    expect(input.map((x) => x.index)).toEqual([0, 1, 2]);
  });
});
