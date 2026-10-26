/** Observe an element's content-box size (ResizeObserver; static fallback in jsdom). */
import { useLayoutEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

export function useElementSize(ref: RefObject<HTMLElement | null>, fallback: ElementSize = { width: 1000, height: 800 }): ElementSize {
  const [size, setSize] = useState<ElementSize>(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize((s) => (s.width === w && s.height === h ? s : { width: w, height: h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
