/** M3 primary tabs with an animated active indicator and horizontal swipe hook. */
import { useEffect, useRef, type PointerEvent, type TouchEvent } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
  readonly badge?: number;
}

export interface TabsProps<T extends string> {
  readonly tabs: readonly TabItem<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly className?: string | undefined;
  readonly label?: string;
}

interface SwipeStartState {
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  locked: 'x' | 'y' | null;
  readonly scrollableEl: HTMLElement | null;
  readonly startScrollLeft: number;
  readonly pointerId?: number | undefined;
}

function findHorizontalScrollAncestor(target: EventTarget | null, boundary: HTMLElement | null): HTMLElement | null {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el !== boundary) {
    if (el.scrollWidth > el.clientWidth + 4 && typeof window !== 'undefined') {
      const ox = window.getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return el;
    }
    el = el.parentElement;
  }
  return null;
}

function canScrollHorizontallyInDirection(el: HTMLElement | null, dx: number, startScrollLeft: number): boolean {
  if (!el) return false;
  if (Math.abs(el.scrollLeft - startScrollLeft) > 4) return true;
  if (dx < 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 4) return true;
  if (dx > 0 && el.scrollLeft > 4) return true;
  return false;
}

/**
 * Horizontal touch/pointer swipe hook for switching between ordered tabs (`order`).
 * - Swiping left (`dx < 0`, right-to-left) advances to the next tab (`idx + 1`).
 * - Swiping right (`dx > 0`, left-to-right) returns to the previous tab (`idx - 1`).
 * - Attaches a native `{ passive: false }` `touchmove` listener during active touches
 *   so Android WebView never cancels (`touchcancel`) horizontal swipes on blank areas.
 * - Ignores touches starting within 24 px of the viewport left/right edge so
 *   Android full-screen edge-back gestures never accidentally switch tabs.
 * - Ignores touches on inputs/sliders or horizontally scrollable bars that are not at their edge.
 */
export function useTabSwipe<T extends string>(
  order: readonly T[],
  value: T,
  onChange: (next: T) => void,
): {
  readonly onTouchStart: (e: TouchEvent<HTMLElement>) => void;
  readonly onTouchMove: (e: TouchEvent<HTMLElement>) => void;
  readonly onTouchEnd: (e: TouchEvent<HTMLElement>) => void;
  readonly onTouchCancel: () => void;
  readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: () => void;
} {
  const stateRef = useRef<SwipeStartState | null>(null);
  const lastTouchTimeRef = useRef(0);
  const cleanupWindowTouchMoveRef = useRef<(() => void) | null>(null);

  const detachWindowTouchMove = (): void => {
    if (cleanupWindowTouchMoveRef.current) {
      cleanupWindowTouchMoveRef.current();
      cleanupWindowTouchMoveRef.current = null;
    }
  };

  useEffect(() => () => detachWindowTouchMove(), []);

  const commitSwipe = (s: SwipeStartState, endX: number, endY: number): void => {
    const dx = endX - s.startX;
    const dy = endY - s.startY;
    if (s.locked === 'y') return;
    if (canScrollHorizontallyInDirection(s.scrollableEl, dx, s.startScrollLeft)) return;
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
    const idx = order.indexOf(value);
    if (idx < 0) return;
    if (dx < 0 && idx < order.length - 1) {
      onChange(order[idx + 1]!);
    } else if (dx > 0 && idx > 0) {
      onChange(order[idx - 1]!);
    }
  };

  const updateMoveLock = (s: SwipeStartState, clientX: number, clientY: number): void => {
    s.lastX = clientX;
    s.lastY = clientY;
    if (s.locked === null) {
      const dx = clientX - s.startX;
      const dy = clientY - s.startY;
      if (Math.hypot(dx, dy) > 10) {
        if (
          !canScrollHorizontallyInDirection(s.scrollableEl, dx, s.startScrollLeft) &&
          Math.abs(dx) > Math.abs(dy) * 1.15
        ) {
          s.locked = 'x';
        } else if (Math.abs(dy) > Math.abs(dx) * 1.15) {
          s.locked = 'y';
        }
      }
    }
  };

  const isIgnoredTarget = (target: EventTarget | null, clientX: number): boolean => {
    if (typeof window !== 'undefined' && window.innerWidth > 200) {
      if (clientX <= 24 || clientX >= window.innerWidth - 24) return true;
    }
    return (
      target instanceof Element &&
      Boolean(target.closest('input, textarea, select, [role="slider"], [data-no-tab-swipe]'))
    );
  };

  const onTouchStart = (e: TouchEvent<HTMLElement>): void => {
    lastTouchTimeRef.current = Date.now();
    detachWindowTouchMove();
    if (e.touches.length !== 1) {
      stateRef.current = null;
      return;
    }
    const t = e.touches[0]!;
    if (isIgnoredTarget(e.target, t.clientX)) {
      stateRef.current = null;
      return;
    }
    const scrollableEl = findHorizontalScrollAncestor(e.target, e.currentTarget);
    stateRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      lastY: t.clientY,
      locked: null,
      scrollableEl,
      startScrollLeft: scrollableEl ? scrollableEl.scrollLeft : 0,
    };

    if (typeof window !== 'undefined') {
      const onNativeTouchMove = (ev: globalThis.TouchEvent): void => {
        const s = stateRef.current;
        if (!s || ev.touches.length !== 1) return;
        const touch = ev.touches[0]!;
        updateMoveLock(s, touch.clientX, touch.clientY);
        if (s.locked === 'x' && ev.cancelable) {
          ev.preventDefault();
        }
      };
      window.addEventListener('touchmove', onNativeTouchMove, { passive: false });
      cleanupWindowTouchMoveRef.current = () => window.removeEventListener('touchmove', onNativeTouchMove);
    }
  };

  const onTouchMove = (e: TouchEvent<HTMLElement>): void => {
    lastTouchTimeRef.current = Date.now();
    if (e.touches.length !== 1 || !stateRef.current) return;
    const t = e.touches[0]!;
    updateMoveLock(stateRef.current, t.clientX, t.clientY);
  };

  const onTouchEnd = (e: TouchEvent<HTMLElement>): void => {
    lastTouchTimeRef.current = Date.now();
    detachWindowTouchMove();
    const s = stateRef.current;
    stateRef.current = null;
    if (!s) return;
    const changed = e.changedTouches?.[0];
    const endX = changed ? changed.clientX : s.lastX;
    const endY = changed ? changed.clientY : s.lastY;
    commitSwipe(s, endX, endY);
  };

  const onTouchCancel = (): void => {
    lastTouchTimeRef.current = Date.now();
    detachWindowTouchMove();
    const s = stateRef.current;
    stateRef.current = null;
    if (s && s.locked === 'x') {
      commitSwipe(s, s.lastX, s.lastY);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if (e.pointerType === 'touch' || Date.now() - lastTouchTimeRef.current < 500) return;
    if (e.button !== 0 || isIgnoredTarget(e.target, e.clientX)) {
      stateRef.current = null;
      return;
    }
    const scrollableEl = findHorizontalScrollAncestor(e.target, e.currentTarget);
    stateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      locked: null,
      scrollableEl,
      startScrollLeft: scrollableEl ? scrollableEl.scrollLeft : 0,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    if (e.pointerType === 'touch' || !stateRef.current || stateRef.current.pointerId !== e.pointerId) return;
    updateMoveLock(stateRef.current, e.clientX, e.clientY);
  };

  const onPointerUp = (e: PointerEvent<HTMLElement>): void => {
    if (e.pointerType === 'touch' || !stateRef.current || stateRef.current.pointerId !== e.pointerId) return;
    const s = stateRef.current;
    stateRef.current = null;
    commitSwipe(s, e.clientX, e.clientY);
  };

  const onPointerCancel = (): void => {
    stateRef.current = null;
  };

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}

export function Tabs<T extends string>({ tabs, value, onChange, className, label }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('.k-tabs__tab.is-selected');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <div ref={listRef} className={cx('k-tabs', className)} role="tablist" aria-label={label}>
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cx('k-tabs__tab', selected && 'is-selected')}
            onClick={() => onChange(t.value)}
          >
            {t.icon && <Icon name={t.icon} size={20} />}
            <span>{t.label}</span>
            {t.badge !== undefined && t.badge > 0 && <span className="k-badge">{t.badge}</span>}
            <span className="k-tabs__indicator" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
