/**
 * Manga geometry for the UI. Layout / hit-testing come from `@kotori/core/manga`
 * (`buildSpreads`, `deriveCharRegions`, `blockAt`, `charIndexAt`); the crop and
 * client↔page helpers below are UI-only (BubbleSelectTool, overlays).
 */
import {
  buildSpreads,
  blockAt,
  charIndexAt as coreCharIndexAt,
  compareNatural,
  deriveCharRegions,
  parseVolumeName,
  spreadIndexForPage as coreSpreadIndexForPage,
  type MangaBlock,
  type MangaRect,
  type MangaSpread,
  type MangaVolume,
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

/**
 * Derive a clean series title (`作品名称`) from a `MangaVolume` (using
 * `v.seriesTitle` when set, or parsing `v.title` with `parseVolumeName` so
 * author tags, archive extensions, and volume numbers are stripped).
 */
export function inferMangaSeriesTitle(v: { readonly title: string; readonly seriesTitle?: string | undefined }): string {
  const rawSeries = v.seriesTitle && v.seriesTitle.trim() !== '' ? v.seriesTitle.trim() : '';
  if (rawSeries && !rawSeries.startsWith('[') && !rawSeries.startsWith('(')) {
    return rawSeries;
  }
  const parsed = parseVolumeName(rawSeries || v.title).seriesTitle.trim();
  if (parsed) return parsed;
  const stripped = v.title
    .replace(/\s*(?:第\s*\d+\s*[巻卷話话]|(?:vol(?:ume)?\.?|v)\s*\d+|\(\d+\)|\[\d+\]|[-_#]\s*\d+|\s+\d{1,3})\s*$/i, '')
    .trim();
  return stripped || v.title.trim();
}

/**
 * Format a clean display title for a manga volume that prioritizes the work
 * name (`作品名称`) + volume number over raw archive/mokuro filenames.
 */
export function formatMangaVolumeTitle(v: {
  readonly title: string;
  readonly seriesTitle?: string | undefined;
  readonly volumeNumber?: number | undefined;
}): string {
  const seriesTitle = inferMangaSeriesTitle(v);
  const parsed = parseVolumeName(v.title);
  const volNum = v.volumeNumber ?? parsed.volumeNumber;
  if (volNum !== undefined && seriesTitle && !/^\d+$/.test(seriesTitle)) {
    return `${seriesTitle} · 第 ${volNum} 卷`;
  }
  return seriesTitle || v.title;
}

/** Sort volumes within the same series in reading order (volumeNumber → natural title). */
export function sortVolumesInSeries(volumes: readonly MangaVolume[]): MangaVolume[] {
  return [...volumes].sort((a, b) => {
    if (a.volumeNumber !== undefined && b.volumeNumber !== undefined && a.volumeNumber !== b.volumeNumber) {
      return a.volumeNumber - b.volumeNumber;
    }
    return compareNatural(a.title, b.title);
  });
}

/** Find the next volume after `currentVolumeId` within the same series. */
export function findNextSeriesVolume(volumes: readonly MangaVolume[], currentVolumeId: string): MangaVolume | undefined {
  const current = volumes.find((v) => v.id === currentVolumeId);
  if (!current) return undefined;
  const seriesKey = inferMangaSeriesTitle(current).toLowerCase();
  const siblings = sortVolumesInSeries(
    volumes.filter((v) => inferMangaSeriesTitle(v).toLowerCase() === seriesKey),
  );
  const idx = siblings.findIndex((v) => v.id === currentVolumeId);
  return idx >= 0 ? siblings[idx + 1] : undefined;
}

