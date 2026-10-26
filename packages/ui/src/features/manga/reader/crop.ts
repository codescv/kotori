/**
 * Crop / downscale maths for the VLM tools (BubbleSelectTool, PageGuideSheet)
 * plus the canvas rasteriser that turns a plan into an `ImagePayload`.
 *
 * Geometry is planned in *page pixels* (the OCR coordinate space, `page.width`
 * × `page.height`) and mapped onto the decoded image's natural size, which may
 * differ (e.g. a downscaled JPEG or an SVG rendered at another resolution).
 */
import type { ImagePayload, MangaRect } from '@kotori/core';
import { fitWithin } from '../../../lib/manga';

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Source rectangle in natural image pixels + output canvas size. */
export interface CropPlan {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly width: number;
  readonly height: number;
}

/** Bubble crop: `rect` (page px) → natural-pixel source rect, long edge ≤ `maxEdge`. */
export function planCrop(rect: MangaRect, page: Size, natural: Size, maxEdge = 1024): CropPlan {
  const kx = natural.width / Math.max(1, page.width);
  const ky = natural.height / Math.max(1, page.height);
  const left = Math.max(0, Math.min(page.width, Math.min(rect.left, rect.right)));
  const right = Math.max(0, Math.min(page.width, Math.max(rect.left, rect.right)));
  const top = Math.max(0, Math.min(page.height, Math.min(rect.top, rect.bottom)));
  const bottom = Math.max(0, Math.min(page.height, Math.max(rect.top, rect.bottom)));
  const sx = Math.round(left * kx);
  const sy = Math.round(top * ky);
  const sw = Math.max(1, Math.round((right - left) * kx));
  const sh = Math.max(1, Math.round((bottom - top) * ky));
  const out = fitWithin(sw, sh, maxEdge);
  return { sx, sy, sw, sh, width: out.width, height: out.height };
}

/** Whole-page downscale (page guide): long edge ≤ `maxEdge`. */
export function planDownscale(natural: Size, maxEdge = 1536): CropPlan {
  const out = fitWithin(natural.width, natural.height, maxEdge);
  return { sx: 0, sy: 0, sw: Math.max(1, natural.width), sh: Math.max(1, natural.height), width: out.width, height: out.height };
}

/** Remove the `data:<mime>;base64,` prefix. */
export function stripDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/** Minimum drag size (page px) for a selection to count as a bubble. */
export const MIN_SELECTION_PX = 12;

export function isUsableSelection(rect: MangaRect): boolean {
  return rect.right - rect.left >= MIN_SELECTION_PX && rect.bottom - rect.top >= MIN_SELECTION_PX;
}

/** Decode an image URL into an `HTMLImageElement`. */
export function loadImage(url: string, timeoutMs = 8000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/i.test(url) && typeof location !== 'undefined' && !url.startsWith(location.origin)) img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error('image load timed out')), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`failed to load ${url.slice(0, 64)}`));
    };
    img.src = url;
  });
}

/**
 * Rasterise a plan to JPEG (q 0.9) on a canvas. When canvas is unavailable
 * (jsdom / locked-down WebView) an empty payload of the planned size is
 * returned so hosts can re-crop server-side from `rect`.
 */
export function rasterize(img: CanvasImageSource, plan: CropPlan, quality = 0.9): ImagePayload {
  const empty: ImagePayload = { mimeType: 'image/jpeg', base64: '', width: plan.width, height: plan.height };
  if (typeof document === 'undefined') return empty;
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return empty;
  try {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, plan.width, plan.height);
    ctx.drawImage(img, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
    return { mimeType: 'image/jpeg', base64: stripDataUrl(canvas.toDataURL('image/jpeg', quality)), width: plan.width, height: plan.height };
  } catch {
    // Tainted canvas (cross-origin image without CORS) → let the host re-crop.
    return empty;
  }
}

/** Load + crop `rect` of a page image. */
export async function cropPageImage(imageUrl: string, rect: MangaRect, page: Size, maxEdge = 1024): Promise<ImagePayload> {
  try {
    const img = await loadImage(imageUrl);
    const natural = { width: img.naturalWidth || page.width, height: img.naturalHeight || page.height };
    return rasterize(img, planCrop(rect, page, natural, maxEdge));
  } catch {
    const plan = planCrop(rect, page, page, maxEdge);
    return { mimeType: 'image/jpeg', base64: '', width: plan.width, height: plan.height };
  }
}

/** Load + downscale a whole page image. */
export async function downscalePageImage(imageUrl: string, page: Size, maxEdge = 1536): Promise<ImagePayload> {
  try {
    const img = await loadImage(imageUrl);
    const natural = { width: img.naturalWidth || page.width, height: img.naturalHeight || page.height };
    return rasterize(img, planDownscale(natural, maxEdge), 0.85);
  } catch {
    const plan = planDownscale(page, maxEdge);
    return { mimeType: 'image/jpeg', base64: '', width: plan.width, height: plan.height };
  }
}
