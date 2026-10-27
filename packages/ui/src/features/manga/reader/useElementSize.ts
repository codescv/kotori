/** Observe an element's content-box size (ResizeObserver; static fallback in jsdom). */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

export function useElementSize(ref: RefObject<HTMLElement | null>, fallback: ElementSize = { width: 1000, height: 800 }): ElementSize {
  const [size, setSize] = useState<ElementSize>(fallback);
  const observedRef = useRef<HTMLElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === observedRef.current) return;
    roRef.current?.disconnect();
    roRef.current = null;
    observedRef.current = el;
    if (!el) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width) || el.clientWidth;
      const h = Math.round(rect.height) || el.clientHeight;
      if (w > 0 && h > 0) setSize((s) => (s.width === w && s.height === h ? s : { width: w, height: h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  });

  useLayoutEffect(() => () => roRef.current?.disconnect(), []);
  return size;
}
