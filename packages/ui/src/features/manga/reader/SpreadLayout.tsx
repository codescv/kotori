/**
 * Lays out one `MangaSpread` inside the stage. Visual order is always
 * `[left, right]`; in RTL modes `buildSpreads` puts the first-read page in the
 * right slot. Pages are sized in JS from `page.width/height` so both pages
 * share one scale (fit: contain / width / height).
 */
import type { ReactNode } from 'react';
import type { MangaPage, MangaReadingMode, MangaSettings, MangaSpread, MangaSpreadSlot } from '@kotori/core';
import { cx } from '../../../components/m3/cx';
import { PageCanvas } from './PageCanvas';
import type { ElementSize } from './useElementSize';

export interface SpreadLayoutProps {
  readonly spread: MangaSpread;
  readonly page: (index: number) => MangaPage | undefined;
  readonly mode: MangaReadingMode;
  readonly stage: ElementSize;
  readonly fit: MangaSettings['fit'];
  readonly renderOverlay: (page: MangaPage) => ReactNode;
  readonly onPageNaturalSize?: ((pageIndex: number, width: number, height: number) => void) | undefined;
}

export interface SlotBox {
  readonly side: 'left' | 'right';
  readonly page: MangaPage | undefined;
  readonly w: number;
  readonly h: number;
}

const DEFAULT_PAGE_WIDTH = 800;
const DEFAULT_PAGE_HEIGHT = 1200;

const safeWidth = (p: { readonly width: number }): number => (p.width > 0 ? p.width : DEFAULT_PAGE_WIDTH);
const safeHeight = (p: { readonly height: number }): number => (p.height > 0 ? p.height : DEFAULT_PAGE_HEIGHT);

/** Scale that fits `content` into `stage` for a fit mode. */
export function fitScale(content: ElementSize, stage: ElementSize, fit: MangaSettings['fit']): number {
  const sw = stage.width / Math.max(1, content.width);
  const sh = stage.height / Math.max(1, content.height);
  return fit === 'width' ? sw : fit === 'height' ? sh : Math.min(sw, sh);
}

const isSpreadMode = (m: MangaReadingMode): boolean => m === 'spread-rtl' || m === 'spread-ltr';

/** Compute rendered slot dimensions and overall spread box size in CSS px. */
export function computeSpreadLayout(
  spread: MangaSpread,
  page: (index: number) => MangaPage | undefined,
  mode: MangaReadingMode,
  stage: ElementSize,
  fit: MangaSettings['fit'],
): { readonly slots: readonly SlotBox[]; readonly scale: number; readonly width: number; readonly height: number } {
  const slotPage = (s: MangaSpreadSlot): MangaPage | undefined => (s.kind === 'page' ? page(s.pageIndex) : undefined);
  const left = slotPage(spread.left);
  const right = slotPage(spread.right);
  const only = left ?? right;
  const isPortraitStage = stage.width > 0 && stage.height > 0 && stage.width < stage.height;
  let slots: SlotBox[];
  if (!isSpreadMode(mode) || (spread.pageIndexes.length === 1 && only && (safeWidth(only) > safeHeight(only) || isPortraitStage))) {
    slots = only ? [{ side: right ? 'right' : 'left', page: only, w: safeWidth(only), h: safeHeight(only) }] : [];
  } else {
    const ref = only ?? { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
    slots = [
      { side: 'left', page: left, w: safeWidth(left ?? ref), h: safeHeight(left ?? ref) },
      { side: 'right', page: right, w: safeWidth(right ?? ref), h: safeHeight(right ?? ref) },
    ];
  }
  const content = { width: slots.reduce((a, s) => a + s.w, 0), height: Math.max(1, ...slots.map((s) => s.h)) };
  const scale = fitScale(content, stage, fit);
  return { slots, scale, width: content.width * scale, height: content.height * scale };
}

export function SpreadLayout({ spread, page, mode, stage, fit, renderOverlay, onPageNaturalSize }: SpreadLayoutProps) {
  const { slots, scale } = computeSpreadLayout(spread, page, mode, stage, fit);
  return (
    <div className={cx('k-spread', `k-spread--${fit}`)} data-testid="spread" data-page-indexes={spread.pageIndexes.join(',')}>
      {slots.map((s) => (
        <div key={s.side} className={cx('k-spread__slot', !s.page && 'is-blank')} data-slot={s.side} style={{ width: s.w * scale, height: s.h * scale }}>
          {s.page && (
            <PageCanvas page={s.page} width={s.w * scale} height={s.h * scale} onNaturalSize={onPageNaturalSize}>
              {renderOverlay(s.page)}
            </PageCanvas>
          )}
        </div>
      ))}
    </div>
  );
}
