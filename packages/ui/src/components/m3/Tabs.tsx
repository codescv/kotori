/** M3 primary tabs with an animated active indicator and horizontal swipe hook. */
import { useEffect, useRef, type TouchEvent } from 'react';
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
  readonly scrollableEl: HTMLElement | null;
  readonly startScrollLeft: number;
}

function findHorizontalScrollAncestor(target: EventTarget | null, boundary: HTMLElement): HTMLElement | null {
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

/**
 * Horizontal touch-swipe hook for switching between ordered tabs (`order`).
 * - Swiping left (`dx < 0`, right-to-left) advances to the next tab (`idx + 1`).
 * - Swiping right (`dx > 0`, left-to-right) returns to the previous tab (`idx - 1`).
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
} {
  const stateRef = useRef<SwipeStartState | null>(null);

  const onTouchStart = (e: TouchEvent<HTMLElement>): void => {
    if (e.touches.length !== 1) {
      stateRef.current = null;
      return;
    }
    const t = e.touches[0]!;
    if (typeof window !== 'undefined' && window.innerWidth > 200) {
      if (t.clientX <= 24 || t.clientX >= window.innerWidth - 24) {
        stateRef.current = null;
        return;
      }
    }
    if (
      e.target instanceof Element &&
      e.target.closest('input, textarea, select, [role="slider"], [data-no-tab-swipe]')
    ) {
      stateRef.current = null;
      return;
    }
    const scrollableEl = findHorizontalScrollAncestor(e.target, e.currentTarget);
    stateRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      lastY: t.clientY,
      scrollableEl,
      startScrollLeft: scrollableEl ? scrollableEl.scrollLeft : 0,
    };
  };

  const onTouchMove = (e: TouchEvent<HTMLElement>): void => {
    if (e.touches.length !== 1 || !stateRef.current) return;
    const t = e.touches[0]!;
    stateRef.current.lastX = t.clientX;
    stateRef.current.lastY = t.clientY;
  };

  const onTouchEnd = (e: TouchEvent<HTMLElement>): void => {
    const s = stateRef.current;
    stateRef.current = null;
    if (!s) return;
    const changed = e.changedTouches?.[0];
    const endX = changed ? changed.clientX : s.lastX;
    const endY = changed ? changed.clientY : s.lastY;
    const dx = endX - s.startX;
    const dy = endY - s.startY;

    if (s.scrollableEl) {
      if (Math.abs(s.scrollableEl.scrollLeft - s.startScrollLeft) > 4) return;
      if (dx < 0 && s.scrollableEl.scrollLeft + s.scrollableEl.clientWidth < s.scrollableEl.scrollWidth - 4) return;
      if (dx > 0 && s.scrollableEl.scrollLeft > 4) return;
    }

    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
    const idx = order.indexOf(value);
    if (idx < 0) return;
    if (dx < 0 && idx < order.length - 1) {
      onChange(order[idx + 1]!);
    } else if (dx > 0 && idx > 0) {
      onChange(order[idx - 1]!);
    }
  };

  const onTouchCancel = (): void => {
    stateRef.current = null;
  };

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
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
