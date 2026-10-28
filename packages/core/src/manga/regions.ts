/**
 * Per-character hit cells for a manga OCR block.
 *
 * Mirrors Fushi `_mangaGeometryTextRegions` / `_mangaLineRects`
 * (`fushi/lib/src/media/manga/manga_overlay_html.dart`) and
 * `mokuroOrientedRectFromQuad` (`mokuro_geometry.dart`): each line gets an
 * (optionally rotated) rectangle, which is split evenly into one cell per
 * visible grapheme along the writing direction.
 */
import type { MangaBlock, MangaCharRegion, MangaPoint, MangaRect } from '../types';
import { segmentGraphemes } from '../util/graphemes';

/** A rectangle of size `width × height` rotated by `rotation` radians (clockwise) about `(cx, cy)`. */
interface OrientedRect {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

/** A line's cross-axis drift below this fraction of its thickness is treated as upright. */
const TILT_MAX_DRIFT_RATIO = 0.1;

/**
 * Whether rotating a line of `length × thickness` tilted by `tilt` is pointless:
 * unrotated cells would drift `length / 2 · |sin tilt|` at the ends.
 */
function tiltIsNegligible(length: number, thickness: number, tilt: number): boolean {
  return (length / 2) * Math.abs(Math.sin(tilt)) < TILT_MAX_DRIFT_RATIO * thickness;
}

/**
 * Fit a 4-point polygon (any start corner / winding) to an oriented rectangle.
 * Rotation is folded into (-π/4, π/4] (swapping sides as it folds). Returns
 * `undefined` for non-quads or shapes that are clearly not rectangles.
 */
function orientedRectFromQuad(polygon: readonly MangaPoint[]): OrientedRect | undefined {
  if (polygon.length !== 4) return undefined;
  const pt = (i: number): MangaPoint => polygon[i % 4] as MangaPoint;
  const ex = (i: number): number => pt(i + 1)[0] - pt(i)[0];
  const ey = (i: number): number => pt(i + 1)[1] - pt(i)[1];
  const len = (i: number): number => Math.hypot(ex(i), ey(i));
  const [l0, l1, l2, l3] = [len(0), len(1), len(2), len(3)];
  if (Math.min(l0, l1, l2, l3) <= 0) return undefined;
  const similar = (a: number, b: number): boolean => Math.abs(a - b) <= 0.15 * Math.max(a, b) + 1;
  if (!similar(l0, l2) || !similar(l1, l3)) return undefined;
  const cosine = (ex(0) * ex(1) + ey(0) * ey(1)) / (l0 * l1);
  if (Math.abs(cosine) > 0.1) return undefined;
  let rotation = Math.atan2(ey(0), ex(0));
  let width = (l0 + l2) / 2;
  let height = (l1 + l3) / 2;
  // Fold into (-π/4, π/4]: every 90° turn swaps the side lengths.
  while (rotation > Math.PI / 4) {
    rotation -= Math.PI / 2;
    [width, height] = [height, width];
  }
  while (rotation <= -Math.PI / 4) {
    rotation += Math.PI / 2;
    [width, height] = [height, width];
  }
  let cx = 0;
  let cy = 0;
  for (const [x, y] of polygon) {
    cx += x / 4;
    cy += y / 4;
  }
  if (tiltIsNegligible(Math.max(width, height), Math.min(width, height), rotation)) rotation = 0;
  return { cx, cy, width, height, rotation };
}

function upright(r: MangaRect): OrientedRect {
  return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, width: r.right - r.left, height: r.bottom - r.top, rotation: 0 };
}

/**
 * Per-line geometry: `linesCoords` when it has one valid polygon per line
 * (tilted 4-point quads keep their rotation, everything else uses its bounding
 * box); otherwise the block rect split evenly — vertical blocks into columns
 * right→left, horizontal blocks into rows top→bottom.
 */
function lineRects(block: MangaBlock): OrientedRect[] {
  const coords = block.linesCoords;
  if (coords && coords.length === block.lines.length) {
    const parsed: OrientedRect[] = [];
    for (const polygon of coords) {
      if (polygon.length === 0) break;
      const xs = polygon.map((p) => p[0]);
      const ys = polygon.map((p) => p[1]);
      const bbox: MangaRect = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
      if (bbox.right <= bbox.left || bbox.bottom <= bbox.top) break;
      const oriented = orientedRectFromQuad(polygon);
      parsed.push(oriented && oriented.rotation !== 0 ? oriented : upright(bbox));
    }
    if (parsed.length === block.lines.length) return parsed;
  }
  const { left, top, right, bottom } = block.rect;
  const n = block.lines.length;
  const out: OrientedRect[] = [];
  for (let i = 0; i < n; i++) {
    if (block.vertical) {
      const w = (right - left) / n;
      out.push(upright({ left: right - (i + 1) * w, top, right: right - i * w, bottom }));
    } else {
      const h = (bottom - top) / n;
      out.push(upright({ left, top: top + i * h, right, bottom: top + (i + 1) * h }));
    }
  }
  return out;
}

/**
 * Per-character hit cells for `block`. Returns `block.regions` verbatim when the
 * producer supplied a non-empty list; otherwise subdivides each line (see
 * {@link lineRects}) into one cell per non-whitespace grapheme along the writing
 * direction (top→bottom for vertical, left→right for horizontal). Offsets are
 * UTF-16 into `block.text`. Cells on tilted lines carry `rotation` (radians,
 * clockwise) about their own centre, which lies on the tilted line axis.
 */
export function deriveCharRegions(block: MangaBlock): MangaCharRegion[] {
  if (block.regions && block.regions.length > 0) return [...block.regions];
  const { rect } = block;
  if (block.lines.length === 0 || rect.right <= rect.left || rect.bottom <= rect.top) return [];
  const lines = lineRects(block);
  const out: MangaCharRegion[] = [];
  let base = 0;
  block.lines.forEach((line, li) => {
    const chars = segmentGraphemes(line).filter((g) => g.text.trim() !== '');
    const geo = lines[li];
    if (geo && chars.length > 0) {
      const n = chars.length;
      const cos = Math.cos(geo.rotation);
      const sin = Math.sin(geo.rotation);
      // Cell size in the line's local (unrotated) frame.
      const cw = block.vertical ? geo.width : geo.width / n;
      const ch = block.vertical ? geo.height / n : geo.height;
      chars.forEach((g, i) => {
        // Cell centre offset from the line centre along the local axes.
        const lx = block.vertical ? 0 : -geo.width / 2 + (i + 0.5) * cw;
        const ly = block.vertical ? -geo.height / 2 + (i + 0.5) * ch : 0;
        const cx = geo.cx + lx * cos - ly * sin;
        const cy = geo.cy + lx * sin + ly * cos;
        out.push({
          rect: { left: cx - cw / 2, top: cy - ch / 2, right: cx + cw / 2, bottom: cy + ch / 2 },
          utf16Start: base + g.start,
          utf16End: base + g.end,
          ...(geo.rotation !== 0 ? { rotation: geo.rotation } : {}),
        });
      });
    }
    base += line.length;
  });
  return out;
}

/** Anything with a page-pixel box: `box = [x1, y1, x2, y2]` or a `MangaRect`. */
export type ReadingOrderItem = { readonly box: readonly [number, number, number, number] } | { readonly rect: MangaRect };

interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function boundsOf(item: ReadingOrderItem): Bounds {
  if ('box' in item) {
    const [x1, y1, x2, y2] = item.box;
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
  }
  const r = item.rect;
  return { left: Math.min(r.left, r.right), top: Math.min(r.top, r.bottom), right: Math.max(r.left, r.right), bottom: Math.max(r.top, r.bottom) };
}

/** Length of the overlap of `[a0, a1]` and `[b0, b1]` (0 when disjoint). */
function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Fraction of the shorter interval that must overlap to share a tier / column. */
const ORDER_OVERLAP_RATIO = 0.4;

/**
 * Sort manga text blocks in Japanese reading order: top-right → bottom-left.
 *
 * 1. Blocks are grouped into horizontal **tiers**: a block joins the current
 *    tier when its vertical extent overlaps the tier's vertical extent by
 *    ≥ 40 % of the shorter of the two (plus a 1 % page-height slack when
 *    `pageHeight` is given). Tiers are read top to bottom.
 * 2. Inside a tier, blocks are grouped into **columns** by horizontal overlap
 *    (same 40 % rule on widths); columns are read right to left and blocks
 *    inside a column top to bottom.
 *
 * Accepts `box = [x1, y1, x2, y2]` items or `MangaBlock`-like `rect` items.
 * Returns a new array; the input is not mutated. Stable for identical boxes.
 */
export function sortBlocksInReadingOrder<T extends ReadingOrderItem>(blocks: readonly T[], pageWidth?: number, pageHeight?: number): T[] {
  const ySlack = pageHeight !== undefined && pageHeight > 0 ? pageHeight * 0.01 : 0;
  const xSlack = pageWidth !== undefined && pageWidth > 0 ? pageWidth * 0.01 : 0;
  const items = blocks.map((item, order) => ({ item, order, b: boundsOf(item) }));
  items.sort((p, q) => p.b.top - q.b.top || q.b.right - p.b.right || p.order - q.order);

  type Entry = (typeof items)[number];
  const tiers: { top: number; bottom: number; members: Entry[] }[] = [];
  for (const e of items) {
    const h = e.b.bottom - e.b.top;
    const tier = tiers[tiers.length - 1];
    if (tier) {
      const shorter = Math.min(h, tier.bottom - tier.top);
      if (overlap(e.b.top, e.b.bottom, tier.top, tier.bottom) + ySlack >= ORDER_OVERLAP_RATIO * shorter) {
        tier.members.push(e);
        tier.bottom = Math.max(tier.bottom, e.b.bottom);
        continue;
      }
    }
    tiers.push({ top: e.b.top, bottom: e.b.bottom, members: [e] });
  }

  const out: T[] = [];
  for (const tier of tiers) {
    // Right-most first, then cluster into columns by horizontal overlap.
    const byRight = [...tier.members].sort((p, q) => q.b.right - p.b.right || p.b.top - q.b.top || p.order - q.order);
    const columns: { left: number; right: number; members: Entry[] }[] = [];
    for (const e of byRight) {
      const w = e.b.right - e.b.left;
      const col = columns.find((c) => overlap(e.b.left, e.b.right, c.left, c.right) + xSlack >= ORDER_OVERLAP_RATIO * Math.min(w, c.right - c.left));
      if (col) {
        col.members.push(e);
        col.left = Math.min(col.left, e.b.left);
        col.right = Math.max(col.right, e.b.right);
      } else {
        columns.push({ left: e.b.left, right: e.b.right, members: [e] });
      }
    }
    columns.sort((p, q) => q.right - p.right);
    for (const col of columns) {
      col.members.sort((p, q) => p.b.top - q.b.top || q.b.right - p.b.right || p.order - q.order);
      for (const e of col.members) out.push(e.item);
    }
  }
  return out;
}
