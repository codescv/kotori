/**
 * Page-pixel hit testing for the manga reader overlay.
 */
import type { MangaBlock, MangaPage, MangaRect } from '../types';
import { deriveCharRegions } from './regions';

const area = (r: MangaRect): number => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/**
 * The block under page-pixel point `(x, y)` (rect edges inclusive). When blocks
 * overlap, the highest `zIndex` wins, then the smallest area (the inner bubble).
 */
export function blockAt(page: Pick<MangaPage, 'blocks'>, x: number, y: number): MangaBlock | undefined {
  let best: MangaBlock | undefined;
  for (const block of page.blocks) {
    const r = block.rect;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    if (!best || block.zIndex > best.zIndex || (block.zIndex === best.zIndex && area(r) < area(best.rect))) best = block;
  }
  return best;
}

/**
 * UTF-16 offset into `block.text` of the character whose hit cell centre is
 * nearest to page-pixel point `(x, y)`. Uses `block.regions` or derives them via
 * {@link deriveCharRegions}. Returns `-1` when the block has no character cells
 * (e.g. empty text).
 */
export function charIndexAt(block: MangaBlock, x: number, y: number): number {
  let bestIndex = -1;
  let bestDist = Infinity;
  for (const region of deriveCharRegions(block)) {
    const r = region.rect;
    // Rotation is about the cell centre, so the centre is rotation-invariant.
    const dx = (r.left + r.right) / 2 - x;
    const dy = (r.top + r.bottom) / 2 - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      bestIndex = region.utf16Start;
    }
  }
  return bestIndex;
}
