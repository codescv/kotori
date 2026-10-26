/**
 * UI-local manga geometry helpers mirroring `@kotori/core/manga` (`layout.ts`,
 * `regions.ts`, `hit-test.ts`) plus crop maths for the VLM bubble tool.
 * All inputs/outputs are in original page pixels unless named `Fraction`.
 */
import type {
  MangaBlock,
  MangaCharRegion,
  MangaPage,
  MangaReadingMode,
  MangaRect,
  MangaSpread,
  MangaSpreadSlot,
} from '@kotori/core';

export interface PageSize {
  readonly index: number;
  readonly width: number;
  readonly height: number;
}

const page = (pageIndex: number): MangaSpreadSlot => ({ kind: 'page', pageIndex });
const blank: MangaSpreadSlot = { kind: 'blank' };

/**
 * Group pages into layout units. Single/webtoon modes → one page per unit.
 * Spread modes: cover alone when `coverIsSingle`, wide pages alone, RTL fills
 * the right slot first (`pageIndexes` is always reading order).
 */
export function buildSpreads(
  pages: readonly PageSize[],
  opts: { readonly mode: MangaReadingMode; readonly coverIsSingle: boolean },
): MangaSpread[] {
  const spreads: MangaSpread[] = [];
  const rtl = opts.mode === 'spread-rtl' || opts.mode === 'single-rtl';
  const isSpread = opts.mode === 'spread-rtl' || opts.mode === 'spread-ltr';
  const single = (p: PageSize): MangaSpread => ({
    index: spreads.length,
    left: rtl ? blank : page(p.index),
    right: rtl ? page(p.index) : blank,
    pageIndexes: [p.index],
  });
  if (!isSpread) {
    for (const p of pages) spreads.push(single(p));
    return spreads;
  }
  let i = 0;
  while (i < pages.length) {
    const first = pages[i];
    if (!first) break;
    const isWide = (p: PageSize): boolean => p.width > p.height;
    if ((i === 0 && opts.coverIsSingle) || isWide(first)) {
      spreads.push(single(first));
      i++;
      continue;
    }
    const second = pages[i + 1];
    if (!second || isWide(second)) {
      spreads.push(single(first));
      i++;
      continue;
    }
    spreads.push({
      index: spreads.length,
      right: page(rtl ? first.index : second.index),
      left: page(rtl ? second.index : first.index),
      pageIndexes: [first.index, second.index],
    });
    i += 2;
  }
  return spreads;
}

export function spreadIndexForPage(spreads: readonly MangaSpread[], pageIndex: number): number {
  const i = spreads.findIndex((s) => s.pageIndexes.includes(pageIndex));
  return i < 0 ? 0 : i;
}

function splitGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

function boundsOf(points: readonly (readonly [number, number])[]): MangaRect | undefined {
  if (points.length === 0) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

/**
 * Per-character hit cells for a block: explicit `regions`, else each line box
 * (from `linesCoords`, or the block rect split evenly — vertical text columns
 * run right→left) subdivided per grapheme along the writing direction.
 */
export function deriveCharRegions(block: MangaBlock): MangaCharRegion[] {
  if (block.regions && block.regions.length > 0) return [...block.regions];
  const out: MangaCharRegion[] = [];
  const { rect, lines, vertical } = block;
  const n = Math.max(1, lines.length);
  let offset = 0;
  lines.forEach((line, li) => {
    const fromCoords = block.linesCoords?.[li] ? boundsOf(block.linesCoords[li] ?? []) : undefined;
    let lineRect: MangaRect;
    if (fromCoords) lineRect = fromCoords;
    else if (vertical) {
      const w = (rect.right - rect.left) / n;
      const right = rect.right - li * w;
      lineRect = { left: right - w, right, top: rect.top, bottom: rect.bottom };
    } else {
      const h = (rect.bottom - rect.top) / n;
      const top = rect.top + li * h;
      lineRect = { left: rect.left, right: rect.right, top, bottom: top + h };
    }
    const gs = splitGraphemes(line);
    const count = Math.max(1, gs.length);
    gs.forEach((g, gi) => {
      const cell: MangaRect = vertical
        ? {
            left: lineRect.left,
            right: lineRect.right,
            top: lineRect.top + ((lineRect.bottom - lineRect.top) * gi) / count,
            bottom: lineRect.top + ((lineRect.bottom - lineRect.top) * (gi + 1)) / count,
          }
        : {
            top: lineRect.top,
            bottom: lineRect.bottom,
            left: lineRect.left + ((lineRect.right - lineRect.left) * gi) / count,
            right: lineRect.left + ((lineRect.right - lineRect.left) * (gi + 1)) / count,
          };
      out.push({ rect: cell, utf16Start: offset, utf16End: offset + g.length });
      offset += g.length;
    });
  });
  return out;
}

const area = (r: MangaRect): number => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
const inside = (r: MangaRect, x: number, y: number): boolean => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/** Block under a page-pixel point: highest `zIndex`, then smallest area. */
export function blockAt(p: Pick<MangaPage, 'blocks'>, x: number, y: number): MangaBlock | undefined {
  let best: MangaBlock | undefined;
  for (const b of p.blocks) {
    if (!inside(b.rect, x, y)) continue;
    if (!best || b.zIndex > best.zIndex || (b.zIndex === best.zIndex && area(b.rect) < area(best.rect))) best = b;
  }
  return best;
}

/** UTF-16 index of the character cell nearest to the point (by cell centre). */
export function charIndexAt(block: MangaBlock, x: number, y: number): number {
  const regions = deriveCharRegions(block);
  let best = 0;
  let bestDist = Infinity;
  for (const r of regions) {
    const cx = (r.rect.left + r.rect.right) / 2;
    const cy = (r.rect.top + r.rect.bottom) / 2;
    const d = inside(r.rect, x, y) ? -1 : (cx - x) ** 2 + (cy - y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = r.utf16Start;
      if (d < 0) break;
    }
  }
  return best;
}

/** Normalise a drag (any direction) into a rect clamped to the page. */
export function normaliseDragRect(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  pageWidth: number,
  pageHeight: number,
): MangaRect {
  const clampX = (v: number): number => Math.min(Math.max(0, v), pageWidth);
  const clampY = (v: number): number => Math.min(Math.max(0, v), pageHeight);
  return {
    left: Math.round(clampX(Math.min(a.x, b.x))),
    top: Math.round(clampY(Math.min(a.y, b.y))),
    right: Math.round(clampX(Math.max(a.x, b.x))),
    bottom: Math.round(clampY(Math.max(a.y, b.y))),
  };
}

/** Output size for a crop so the long edge is ≤ `maxEdge` (never upscales). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number } {
  const longEdge = Math.max(width, height);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** Convert a client-space point to page pixels given the rendered element box. */
export function clientToPage(
  clientX: number,
  clientY: number,
  box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number } {
  return {
    x: ((clientX - box.left) / Math.max(1, box.width)) * pageWidth,
    y: ((clientY - box.top) / Math.max(1, box.height)) * pageHeight,
  };
}

export const rectWidth = (r: MangaRect): number => r.right - r.left;
export const rectHeight = (r: MangaRect): number => r.bottom - r.top;
