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
