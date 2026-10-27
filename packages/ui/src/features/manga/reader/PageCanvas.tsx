/**
 * One manga page: `<img>` plus an overlay layer that shares the page's pixel
 * box, so overlays (OCR blocks, guide markers, the bubble select tool) can
 * position themselves with `viewBox="0 0 page.width page.height"` or
 * percentages. `ZoomPan` adds wheel / pinch zoom, drag panning, single-finger
 * swipe page-turn, edge-tap page-turn, and double-tap zoom.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { MangaPage } from '@kotori/core';
import { cx } from '../../../components/m3/cx';
import type { ElementSize } from './useElementSize';

export interface PageCanvasProps {
  readonly page: MangaPage;
  /** Rendered box size in CSS px (computed by the layout). */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly eager?: boolean;
  /** Reports intrinsic image dimensions when `page.width` or `page.height` was unknown (0). */
  readonly onNaturalSize?: ((pageIndex: number, width: number, height: number) => void) | undefined;
}

export function PageCanvas({ page, width, height, children, className, eager = true, onNaturalSize }: PageCanvasProps) {
  const safeW = page.width > 0 ? page.width : 800;
  const safeH = page.height > 0 ? page.height : 1200;
  const style: CSSProperties =
    width !== undefined && height !== undefined ? { width, height } : { aspectRatio: `${safeW} / ${safeH}`, width: '100%' };
  return (
    <div className={cx('k-page-canvas', className)} style={style} data-page-index={page.index}>
      <img
        className="k-page-canvas__img"
        src={page.imageUrl}
        alt={`p.${page.index + 1}`}
        draggable={false}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onLoad={(e) => {
          if ((page.width <= 0 || page.height <= 0) && onNaturalSize) {
            const nw = e.currentTarget.naturalWidth;
            const nh = e.currentTarget.naturalHeight;
            if (nw > 0 && nh > 0) onNaturalSize(page.index, nw, nh);
          }
        }}
      />
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
  /** Rendered content box size at scale=1 (in CSS px). */
  readonly contentSize?: ElementSize | undefined;
  /** Stage viewport size (in CSS px). */
  readonly stageSize?: ElementSize | undefined;
  /** Called when the user swipes horizontally from right to left (dx < 0) at 1× scale. */
  readonly onSwipeLeft?: (() => void) | undefined;
  /** Called when the user swipes horizontally from left to right (dx > 0) at 1× scale. */
  readonly onSwipeRight?: (() => void) | undefined;
  /** Called when the user taps the left or right edge zone of the stage outside OCR blocks. */
  readonly onEdgeTap?: ((side: 'left' | 'right') => void) | undefined;
}

interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface BoxRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface PinchState {
  readonly startDist: number;
  readonly startMid: Point;
  readonly startView: View;
}

interface SingleState {
  readonly start: Point;
  last: Point;
  readonly target: EventTarget | null;
}

const clampScale = (s: number, min = 1): number => Math.min(5, Math.max(min, s));

const isInteractiveElement = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest('.k-block, .k-guide-marker, button, a, input, select, textarea'));

/**
 * Multi-gesture stage wrapper:
 * - Ctrl/⌘ + wheel or two-finger pinch zooms around the focal point;
 * - Single-finger drag pans when zoomed in (or scrolls vertically when `fit="width"` overflows);
 * - Single-finger horizontal swipe turns the page when at 1× scale;
 * - Single tap on the outer 28% left/right edge turns the page (outside OCR speech bubbles);
 * - Double-tap / double-click toggles 2× zoom at the tap point.
 */
export function ZoomPan({
  children,
  disabled,
  className,
  resetKey,
  contentSize,
  stageSize,
  onSwipeLeft,
  onSwipeRight,
  onEdgeTap,
}: ZoomPanProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const initialY = useCallback((): number => {
    const ch = contentSize?.height ?? 0;
    const sh = stageSize?.height ?? 0;
    return ch > sh && sh > 0 ? (ch - sh) / 2 : 0;
  }, [contentSize?.height, stageSize?.height]);

  const [view, setView] = useState<View>(() => ({ scale: 1, x: 0, y: initialY() }));
  const viewRef = useRef<View>(view);
  viewRef.current = view;

  const [dragX, setDragX] = useState(0);
  const [gesturing, setGesturing] = useState(false);

  const [lastKey, setLastKey] = useState(resetKey);
  if (lastKey !== resetKey) {
    setLastKey(resetKey);
    const nextView = { scale: 1, x: 0, y: initialY() };
    setView(nextView);
    viewRef.current = nextView;
    if (dragX !== 0) setDragX(0);
    if (gesturing) setGesturing(false);
  }

  const updateView = useCallback((next: View | ((prev: View) => View)) => {
    setView((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      viewRef.current = resolved;
      return resolved;
    });
  }, []);

  const resolveRect = useCallback(
    (el: HTMLElement): BoxRect => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        width: r.width > 0 ? r.width : (stageSize?.width ?? 1000),
        height: r.height > 0 ? r.height : (stageSize?.height ?? 800),
      };
    },
    [stageSize?.width, stageSize?.height],
  );

  const clampView = useCallback(
    (next: View, rect: BoxRect, allowUnderScale = false): View => {
      const sw = rect.width > 0 ? rect.width : (stageSize?.width ?? 1000);
      const sh = rect.height > 0 ? rect.height : (stageSize?.height ?? 800);
      const cw = contentSize && contentSize.width > 0 ? contentSize.width : sw;
      const ch = contentSize && contentSize.height > 0 ? contentSize.height : sh;
      if (next.scale <= 1.01) {
        const maxY = Math.max(0, (ch - sh) / 2);
        const scale = allowUnderScale ? clampScale(next.scale, 0.75) : 1;
        return { scale, x: 0, y: Math.min(maxY, Math.max(-maxY, next.y)) };
      }
      const maxX = Math.max(0, (cw * next.scale - sw) / 2);
      const maxY = Math.max(0, (ch * next.scale - sh) / 2);
      return {
        scale: next.scale,
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      };
    },
    [contentSize, stageSize],
  );

  // Re-clamp vertical alignment if contentSize / stageSize updates at 1× scale.
  useEffect(() => {
    if (viewRef.current.scale <= 1.01) {
      const el = containerRef.current;
      const rect = el ? resolveRect(el) : { left: 0, top: 0, width: stageSize?.width ?? 1000, height: stageSize?.height ?? 800 };
      updateView((v) => clampView(v, rect));
    }
  }, [contentSize?.width, contentSize?.height, stageSize?.width, stageSize?.height, clampView, resolveRect, updateView]);

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number, rect: BoxRect) => {
      updateView((v) => {
        const scale = clampScale(v.scale * factor);
        if (scale <= 1.01) return { scale: 1, x: 0, y: initialY() };
        const px = cx - rect.left - rect.width / 2;
        const py = cy - rect.top - rect.height / 2;
        const k = scale / v.scale;
        return clampView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, rect);
      });
    },
    [clampView, initialY, updateView],
  );

  const pointers = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchState | null>(null);
  const singleRef = useRef<SingleState | null>(null);
  const movedRef = useRef(false);
  const pinchedRef = useRef(false);
  const suppressClick = useRef(false);
  const lastTouchTime = useRef(0);
  const lastTapRef = useRef<{ readonly time: number; readonly x: number; readonly y: number } | null>(null);
  const lastDoubleTapTime = useRef(0);

  // Native non-passive touch listeners so Android WebView never cancels or hijacks 2-finger pinch or 1-finger swipe.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || disabled) return;
    const onNativeTouchStart = (e: TouchEvent): void => {
      if (e.touches.length >= 2 && e.cancelable) e.preventDefault();
    };
    const onNativeTouchMove = (e: TouchEvent): void => {
      if ((e.touches.length >= 2 || movedRef.current || viewRef.current.scale > 1.01) && e.cancelable) {
        e.preventDefault();
      }
    };
    el.addEventListener('touchstart', onNativeTouchStart, { passive: false });
    el.addEventListener('touchmove', onNativeTouchMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onNativeTouchStart);
      el.removeEventListener('touchmove', onNativeTouchMove);
    };
  }, [disabled]);

  const syncPointsStart = (pts: readonly Point[], target: EventTarget | null) => {
    if (pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[1]!;
      pinchRef.current = {
        startDist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startView: viewRef.current,
      };
      movedRef.current = true;
      pinchedRef.current = true;
      setDragX(0);
      setGesturing(true);
    } else if (pts.length === 1 && !pinchedRef.current) {
      const p = pts[0]!;
      singleRef.current = { start: { x: p.x, y: p.y }, last: { x: p.x, y: p.y }, target };
      movedRef.current = false;
      pinchedRef.current = false;
    }
  };

  const syncPointsMove = (pts: readonly Point[], rect: BoxRect) => {
    if (pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[1]!;
      if (!pinchRef.current) {
        pinchRef.current = {
          startDist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
          startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          startView: viewRef.current,
        };
      }
      const p = pinchRef.current;
      movedRef.current = true;
      pinchedRef.current = true;
      setDragX(0);
      setGesturing(true);
      const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = clampScale(p.startView.scale * (dist / p.startDist), 0.75);
      const px = p.startMid.x - rect.left - rect.width / 2;
      const py = p.startMid.y - rect.top - rect.height / 2;
      const k = scale / p.startView.scale;
      const rawX = px - (px - p.startView.x) * k + (mid.x - p.startMid.x);
      const rawY = py - (py - p.startView.y) * k + (mid.y - p.startMid.y);
      updateView(clampView({ scale, x: rawX, y: rawY }, rect, true));
      return;
    }

    if (pts.length === 1) {
      const p = pts[0]!;
      if (pinchRef.current) {
        // Transitioned from 2 fingers down to 1 finger: re-anchor single-finger pan.
        pinchRef.current = null;
        if (viewRef.current.scale < 1) {
          updateView({ scale: 1, x: 0, y: initialY() });
        }
        singleRef.current = { start: { x: p.x, y: p.y }, last: { x: p.x, y: p.y }, target: null };
        return;
      }
      const s = singleRef.current;
      if (!s) return;
      const dx = p.x - s.start.x;
      const dy = p.y - s.start.y;
      const stepX = p.x - s.last.x;
      const stepY = p.y - s.last.y;
      s.last = { x: p.x, y: p.y };

      if (!movedRef.current && Math.hypot(dx, dy) > 8) {
        movedRef.current = true;
        setGesturing(true);
      }
      if (!movedRef.current) return;

      if (viewRef.current.scale > 1.01) {
        updateView((v) => clampView({ scale: v.scale, x: v.x + stepX, y: v.y + stepY }, rect));
      } else {
        const sh = rect.height > 0 ? rect.height : (stageSize?.height ?? 800);
        const ch = contentSize && contentSize.height > 0 ? contentSize.height : sh;
        const maxY = Math.max(0, (ch - sh) / 2);
        if (maxY > 2 && Math.abs(dy) >= Math.abs(dx)) {
          updateView((v) => clampView({ scale: 1, x: 0, y: v.y + stepY }, rect));
        } else if (Math.abs(dx) > Math.abs(dy)) {
          setDragX(Math.sign(dx) * Math.min(Math.abs(dx) * 0.45, 90));
        }
      }
    }
  };

  const finishAllPoints = (rect: BoxRect) => {
    setDragX(0);
    setGesturing(false);
    if (viewRef.current.scale < 1) {
      updateView({ scale: 1, x: 0, y: initialY() });
    }
    const wasMoved = movedRef.current;
    const wasPinched = pinchedRef.current;
    const single = singleRef.current;

    pinchRef.current = null;
    singleRef.current = null;
    movedRef.current = false;
    pinchedRef.current = false;

    if (wasMoved || wasPinched) {
      suppressClick.current = true;
      if (!wasPinched && single && viewRef.current.scale <= 1.01) {
        const dx = single.last.x - single.start.x;
        const dy = single.last.y - single.start.y;
        if (Math.abs(dx) >= 42 && Math.abs(dx) > Math.abs(dy) * 1.15) {
          if (dx < 0) onSwipeLeft?.();
          else onSwipeRight?.();
        }
      }
      return;
    }

    if (single && !isInteractiveElement(single.target)) {
      const tapX = single.last.x;
      const tapY = single.last.y;
      const relX = (tapX - rect.left) / Math.max(1, rect.width);
      const now = Date.now();
      const prevTap = lastTapRef.current;

      // Edge tap at 1× scale turns the page immediately.
      if (viewRef.current.scale <= 1.01 && (relX <= 0.28 || relX >= 0.72)) {
        lastTapRef.current = null;
        onEdgeTap?.(relX <= 0.28 ? 'left' : 'right');
        return;
      }

      // Center tap (or tap anywhere while zoomed in): detect double-tap to toggle 2× zoom.
      if (prevTap && now - prevTap.time < 320 && Math.hypot(tapX - prevTap.x, tapY - prevTap.y) < 36) {
        lastTapRef.current = null;
        lastDoubleTapTime.current = now;
        if (viewRef.current.scale > 1.01) updateView({ scale: 1, x: 0, y: initialY() });
        else zoomAt(2, tapX, tapY, rect);
      } else {
        lastTapRef.current = { time: now, x: tapX, y: tapY };
      }
    }
  };

  const resetGesture = () => {
    pointers.current.clear();
    pinchRef.current = null;
    singleRef.current = null;
    movedRef.current = false;
    pinchedRef.current = false;
    setDragX(0);
    setGesturing(false);
    if (viewRef.current.scale < 1) {
      updateView({ scale: 1, x: 0, y: initialY() });
    }
  };

  return (
    <div
      ref={containerRef}
      className={cx('k-zoompan', view.scale > 1.01 && 'is-zoomed', gesturing && 'is-gesturing', className)}
      data-testid="zoompan"
      data-scale={view.scale.toFixed(2)}
      onWheel={(e) => {
        if (disabled || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY, resolveRect(e.currentTarget));
      }}
      onDoubleClick={(e) => {
        if (disabled || isInteractiveElement(e.target)) return;
        if (Date.now() - lastDoubleTapTime.current < 450 || Date.now() - lastTouchTime.current < 450) return;
        const rect = resolveRect(e.currentTarget);
        const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
        if (viewRef.current.scale <= 1.01 && (relX <= 0.28 || relX >= 0.72)) return;
        if (viewRef.current.scale > 1.01) updateView({ scale: 1, x: 0, y: initialY() });
        else zoomAt(2, e.clientX, e.clientY, rect);
      }}
      onTouchStart={(e) => {
        if (disabled) return;
        lastTouchTime.current = Date.now();
        const pts = Array.from(e.touches, (t) => ({ x: t.clientX, y: t.clientY }));
        syncPointsStart(pts, e.target);
      }}
      onTouchMove={(e) => {
        if (disabled) return;
        lastTouchTime.current = Date.now();
        const pts = Array.from(e.touches, (t) => ({ x: t.clientX, y: t.clientY }));
        syncPointsMove(pts, resolveRect(e.currentTarget));
      }}
      onTouchEnd={(e) => {
        if (disabled) return;
        lastTouchTime.current = Date.now();
        const rect = resolveRect(e.currentTarget);
        if (e.touches.length === 0) {
          finishAllPoints(rect);
        } else {
          const pts = Array.from(e.touches, (t) => ({ x: t.clientX, y: t.clientY }));
          syncPointsMove(pts, rect);
        }
      }}
      onTouchCancel={() => {
        lastTouchTime.current = Date.now();
        resetGesture();
      }}
      onPointerDown={(e) => {
        if (disabled || e.pointerType === 'touch' || Date.now() - lastTouchTime.current < 500) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        syncPointsStart([...pointers.current.values()], e.target);
      }}
      onPointerMove={(e) => {
        if (disabled || e.pointerType === 'touch' || !pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        syncPointsMove([...pointers.current.values()], resolveRect(e.currentTarget));
      }}
      onPointerUp={(e) => {
        if (disabled || e.pointerType === 'touch' || !pointers.current.has(e.pointerId)) return;
        pointers.current.delete(e.pointerId);
        const rect = resolveRect(e.currentTarget);
        if (pointers.current.size === 0) {
          finishAllPoints(rect);
        } else {
          syncPointsMove([...pointers.current.values()], rect);
        }
      }}
      onPointerCancel={(e) => {
        if (e.pointerType === 'touch') return;
        pointers.current.delete(e.pointerId);
        if (pointers.current.size === 0) resetGesture();
      }}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      <div
        className="k-zoompan__content"
        style={{ transform: `translate(${view.x + dragX}px, ${view.y}px) scale(${view.scale})` }}
      >
        {children}
      </div>
    </div>
  );
}
