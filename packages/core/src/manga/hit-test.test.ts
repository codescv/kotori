import { describe, expect, it } from 'vitest';
import type { MangaBlock } from '../types';
import { blockAt, charIndexAt } from './hit-test';

function block(index: number, rect: MangaBlock['rect'], zIndex = index, lines: string[] = ['あいう']): MangaBlock {
  return { index, rect, vertical: true, fontSize: 20, zIndex, lines, text: lines.join(''), source: 'mokuro' };
}

describe('blockAt', () => {
  const outer = block(0, { left: 0, top: 0, right: 200, bottom: 200 });
  const inner = block(1, { left: 50, top: 50, right: 100, bottom: 100 }, 0);
  const top = block(2, { left: 150, top: 150, right: 300, bottom: 300 }, 9);
  const page = { blocks: [outer, inner, top] };

  it('returns the containing block (edges inclusive)', () => {
    expect(blockAt(page, 10, 10)).toBe(outer);
    expect(blockAt(page, 200, 0)).toBe(outer);
  });
  it('prefers the smallest area on equal zIndex', () => {
    expect(blockAt(page, 75, 75)).toBe(inner);
  });
  it('prefers the highest zIndex over area', () => {
    expect(blockAt(page, 175, 175)).toBe(top);
  });
  it('returns undefined when nothing is hit', () => {
    expect(blockAt(page, 500, 500)).toBeUndefined();
    expect(blockAt({ blocks: [] }, 0, 0)).toBeUndefined();
  });
});

describe('charIndexAt', () => {
  it('returns the UTF-16 start of the nearest derived cell', () => {
    // Vertical single column 0..30 split into 3 cells of height 30.
    const b = block(0, { left: 0, top: 0, right: 30, bottom: 90 }, 0, ['あ𠮷う']);
    expect(charIndexAt(b, 15, 5)).toBe(0);
    expect(charIndexAt(b, 15, 45)).toBe(1);
    expect(charIndexAt(b, 15, 89)).toBe(3);
    expect(charIndexAt(b, 500, 500)).toBe(3);
  });
  it('uses producer regions when present', () => {
    const b: MangaBlock = {
      ...block(0, { left: 0, top: 0, right: 100, bottom: 100 }, 0, ['ab']),
      regions: [
        { rect: { left: 0, top: 0, right: 10, bottom: 10 }, utf16Start: 1, utf16End: 2 },
        { rect: { left: 90, top: 90, right: 100, bottom: 100 }, utf16Start: 0, utf16End: 1 },
      ],
    };
    expect(charIndexAt(b, 2, 2)).toBe(1);
    expect(charIndexAt(b, 99, 99)).toBe(0);
  });
  it('returns -1 for a block without characters', () => {
    expect(charIndexAt(block(0, { left: 0, top: 0, right: 10, bottom: 10 }, 0, []), 5, 5)).toBe(-1);
  });
});
