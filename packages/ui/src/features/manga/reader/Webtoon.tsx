/**
 * Vertical continuous-scroll reader. Virtualised: page boxes are sized from
 * `page.width/height`, only pages within the viewport ± `preload` screens are
 * mounted; the current page (≈30% down the viewport) is reported upward.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MangaPage } from '@kotori/core';
import { PageCanvas } from './PageCanvas';
import { useElementSize } from './useElementSize';

export interface WebtoonProps {
  readonly pages: readonly MangaPage[];
  readonly initialPage: number;
  readonly onPageChange: (pageIndex: number) => void;
  readonly renderOverlay: (page: MangaPage) => ReactNode;
  /** Extra screens rendered above/below the viewport. */
  readonly preload?: number;
  readonly maxWidth?: number;
}

const GAP = 8;

/** Cumulative layout (top/height per page) for a column of width `width`. */
export function webtoonLayout(pages: readonly Pick<MangaPage, 'width' | 'height'>[], width: number): { tops: number[]; heights: number[]; total: number } {
  const tops: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const p of pages) {
    const h = Math.round((width * p.height) / Math.max(1, p.width));
    tops.push(y);
    heights.push(h);
    y += h + GAP;
  }
  return { tops, heights, total: Math.max(0, y - GAP) };
}

export function Webtoon({ pages, initialPage, onPageChange, renderOverlay, preload = 1, maxWidth = 900 }: WebtoonProps) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const width = Math.min(size.width, maxWidth);
  const layout = useMemo(() => webtoonLayout(pages, width), [pages, width]);
  const [scrollTop, setScrollTop] = useState(0);
  const current = useRef(initialPage);
  const didInit = useRef(false);

  useLayoutEffect(() => {
    if (didInit.current || !ref.current) return;
    didInit.current = true;
    const top = layout.tops[initialPage] ?? 0;
    ref.current.scrollTop = top;
    setScrollTop(top);
  }, [layout, initialPage]);

  const lo = scrollTop - size.height * preload;
  const hi = scrollTop + size.height * (1 + preload);
  const probe = scrollTop + size.height * 0.3;
  let cur = 0;
  layout.tops.forEach((t, i) => {
    if (t <= probe) cur = i;
  });
  useEffect(() => {
    if (cur !== current.current) {
      current.current = cur;
      const p = pages[cur];
      if (p) onPageChange(p.index);
    }
  }, [cur, pages, onPageChange]);

  return (
    <div className="k-webtoon" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="webtoon">
      <div className="k-webtoon__column" style={{ height: layout.total, width }}>
        {pages.map((p, i) => {
          const top = layout.tops[i] ?? 0;
          const h = layout.heights[i] ?? 0;
          if (top + h < lo || top > hi) return null;
          return (
            <div key={p.index} className="k-webtoon__page" style={{ top, height: h, width }}>
              <PageCanvas page={p} width={width} height={h}>
                {renderOverlay(p)}
              </PageCanvas>
            </div>
          );
        })}
      </div>
    </div>
  );
}
