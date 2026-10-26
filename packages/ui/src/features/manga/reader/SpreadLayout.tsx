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
}

interface SlotBox {
  readonly side: 'left' | 'right';
  readonly page: MangaPage | undefined;
  readonly w: number;
  readonly h: number;
}

/** Scale that fits `content` into `stage` for a fit mode. */
export function fitScale(content: ElementSize, stage: ElementSize, fit: MangaSettings['fit']): number {
  const sw = stage.width / Math.max(1, content.width);
  const sh = stage.height / Math.max(1, content.height);
  return fit === 'width' ? sw : fit === 'height' ? sh : Math.min(sw, sh);
}

const isSpreadMode = (m: MangaReadingMode): boolean => m === 'spread-rtl' || m === 'spread-ltr';

export function SpreadLayout({ spread, page, mode, stage, fit, renderOverlay }: SpreadLayoutProps) {
  const slotPage = (s: MangaSpreadSlot): MangaPage | undefined => (s.kind === 'page' ? page(s.pageIndex) : undefined);
  const left = slotPage(spread.left);
  const right = slotPage(spread.right);
  const only = left ?? right;
  let slots: SlotBox[];
  if (!isSpreadMode(mode) || (spread.pageIndexes.length === 1 && only && only.width > only.height)) {
    slots = only ? [{ side: right ? 'right' : 'left', page: only, w: only.width, h: only.height }] : [];
  } else {
    const ref = only ?? { width: 1, height: 1 };
    slots = [
      { side: 'left', page: left, w: (left ?? ref).width, h: (left ?? ref).height },
      { side: 'right', page: right, w: (right ?? ref).width, h: (right ?? ref).height },
    ];
  }
  const content = { width: slots.reduce((a, s) => a + s.w, 0), height: Math.max(1, ...slots.map((s) => s.h)) };
  const scale = fitScale(content, stage, fit);
  return (
    <div className={cx('k-spread', `k-spread--${fit}`)} data-testid="spread" data-page-indexes={spread.pageIndexes.join(',')}>
      {slots.map((s) => (
        <div key={s.side} className={cx('k-spread__slot', !s.page && 'is-blank')} data-slot={s.side} style={{ width: s.w * scale, height: s.h * scale }}>
          {s.page && (
            <PageCanvas page={s.page} width={s.w * scale} height={s.h * scale}>
              {renderOverlay(s.page)}
            </PageCanvas>
          )}
        </div>
      ))}
    </div>
  );
}
