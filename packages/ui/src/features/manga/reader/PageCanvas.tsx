/**
 * One manga page: `<img>` plus an overlay layer that shares the page's pixel
 * box, so overlays (OCR blocks, guide markers, the bubble select tool) can
 * position themselves with `viewBox="0 0 page.width page.height"` or
 * percentages. `ZoomPan` adds wheel / pinch zoom and drag panning.
 */
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { MangaPage } from '@kotori/core';
import { cx } from '../../../components/m3/cx';

export interface PageCanvasProps {
  readonly page: MangaPage;
  /** Rendered box size in CSS px (computed by the layout). */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly eager?: boolean;
}

export function PageCanvas({ page, width, height, children, className, eager = true }: PageCanvasProps) {
  const style: CSSProperties =
    width !== undefined && height !== undefined ? { width, height } : { aspectRatio: `${page.width} / ${page.height}`, width: '100%' };
  return (
    <div className={cx('k-page-canvas', className)} style={style} data-page-index={page.index}>
      <img className="k-page-canvas__img" src={page.imageUrl} alt={`p.${page.index + 1}`} draggable={false} loading={eager ? 'eager' : 'lazy'} decoding="async" />
      <div className="k-page-canvas__overlay">{children}</div>
    </div>
  );
}

export interface ZoomPanProps {
  readonly children: ReactNode;
  /** Disable gestures (e.g. while the bubble select tool owns the pointer). */
  readonly disabled?: boolean;
  readonly className?: string | undefined;
  /** Changing this key resets zoom (e.g. on page turn). */
  readonly resetKey?: string | number;
}

interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

const IDENTITY: View = { scale: 1, x: 0, y: 0 };
const clampScale = (s: number): number => Math.min(5, Math.max(1, s));

/** Ctrl/⌘+wheel or two-finger pinch zooms; drag pans when zoomed; double-click toggles 2×. */
export function ZoomPan({ children, disabled, className, resetKey }: ZoomPanProps) {
  const [view, setView] = useState<View>(IDENTITY);
  const [lastKey, setLastKey] = useState(resetKey);
  if (lastKey !== resetKey) {
    setLastKey(resetKey);
    setView(IDENTITY);
  }
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; moved: boolean; start: { x: number; y: number } } | null>(null);
  const suppressClick = useRef(false);

  const zoomAt = useCallback((factor: number, cx: number, cy: number, rect: DOMRect) => {
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      if (scale === 1) return IDENTITY;
      // Keep the point under the cursor fixed.
      const px = cx - rect.left - rect.width / 2;
      const py = cy - rect.top - rect.height / 2;
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  return (
    <div
      className={cx('k-zoompan', view.scale > 1 && 'is-zoomed', className)}
      onWheel={(e) => {
        if (disabled || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
      }}
      onDoubleClick={(e) => {
        if (disabled) return;
        if (view.scale > 1) setView(IDENTITY);
        else zoomAt(2, e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...pointers.current.values()];
        const a = pts[0];
        const b = pts[1];
        gesture.current = {
          dist: a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
          scale: view.scale,
          moved: false,
          start: { x: e.clientX, y: e.clientY },
        };
      }}
      onPointerMove={(e) => {
        if (disabled || !pointers.current.has(e.pointerId)) return;
        const prev = pointers.current.get(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        if (!g || !prev) return;
        const pts = [...pointers.current.values()];
        if (pts.length >= 2 && g.dist > 0) {
          const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
          const scale = clampScale((g.scale * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist);
          g.moved = true;
          setView((v) => (scale === 1 ? IDENTITY : { ...v, scale }));
        } else if (view.scale > 1) {
          if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 4) g.moved = true;
          if (g.moved) setView((v) => ({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }));
        }
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        if (gesture.current?.moved) suppressClick.current = true;
        if (pointers.current.size === 0) gesture.current = null;
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        gesture.current = null;
      }}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      <div className="k-zoompan__content" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {children}
      </div>
    </div>
  );
}
