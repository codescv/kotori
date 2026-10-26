/**
 * Manga geometry for the UI. Layout / hit-testing come from `@kotori/core/manga`
 * (`buildSpreads`, `deriveCharRegions`, `blockAt`, `charIndexAt`); the crop and
 * client↔page helpers below are UI-only (BubbleSelectTool, overlays).
 */
import {
  buildSpreads,
  blockAt,
  charIndexAt as coreCharIndexAt,
  deriveCharRegions,
  spreadIndexForPage as coreSpreadIndexForPage,
  type MangaBlock,
  type MangaRect,
  type MangaSpread,
  type SpreadPageInfo,
} from '@kotori/core';

export { buildSpreads, blockAt, deriveCharRegions };

export type PageSize = SpreadPageInfo;

/** Spread containing `pageIndex` (0 when absent, so callers can index directly). */
export function spreadIndexForPage(spreads: readonly MangaSpread[], pageIndex: number): number {
  return Math.max(0, coreSpreadIndexForPage(spreads, pageIndex));
}

/** UTF-16 index of the character cell nearest to the point (0 for blocks without cells). */
export function charIndexAt(block: MangaBlock, x: number, y: number): number {
  return Math.max(0, coreCharIndexAt(block, x, y));
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
