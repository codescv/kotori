/** M3 primary tabs with an animated active indicator and horizontal swipe hook. */
import { useEffect, useRef, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
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

/** `'next'` = swipe left (`dx < 0`, idx + 1); `'prev'` = swipe right (`dx > 0`, idx - 1). */
export type TabSwipeDirection = 'next' | 'prev';

export interface TabSwipeOptions {
  /** When `false` every handler is inert (e.g. the Shell swipe inside Player / Reader). Default `true`. */
  readonly enabled?: boolean;
}

export interface TabSwipeHandlers {
  readonly onTouchStart: (e: TouchEvent<HTMLElement>) => void;
  readonly onTouchMove: (e: TouchEvent<HTMLElement>) => void;
  readonly onTouchEnd: (e: TouchEvent<HTMLElement>) => void;
  readonly onTouchCancel: (e: TouchEvent<HTMLElement>) => void;
  readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  readonly onClickCapture: (e: MouseEvent<HTMLElement>) => void;
}

/** Minimum horizontal travel (px) for a tab swipe. */
const SWIPE_MIN_DX = 40;
/** Horizontal travel must dominate vertical travel by this ratio. */
const SWIPE_AXIS_RATIO = 1.15;
/** Viewport edge band (px) reserved for the Android edge-back gesture. */
const EDGE_GUARD_PX = 24;
/** How long after a committed swipe the trailing synthetic `click` is swallowed. */
const CLICK_GUARD_MS = 400;

/** Overlay surfaces whose gestures never belong to a tab swipe container *around* them. */
const OVERLAY_SELECTOR =
  '.k-dialog, .k-dialog-scrim, [role="dialog"], .k-bottom-sheet, .k-bottom-sheet-scrim, .k-side-sheet, .k-menu';
/** Controls that own horizontal drags (text selection / caret, sliders) or opt out explicitly. */
const INTERACTIVE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="slider"], [data-no-tab-swipe]';

/**
 * Native events whose swipe was already claimed by an inner (nested) `useTabSwipe`.
 * React dispatches bubbling handlers innermost-first, so an inner tab strip that can
 * still move in the swipe direction claims the gesture and outer strips skip it; an
 * inner strip already at its edge leaves it unclaimed and the outer strip moves.
 */
const claimedSwipeEvents = new WeakSet<Event>();

/**
 * One-shot guard against the synthetic `click` that follows a horizontal drag which
 * started on a card / button (mouse drags always click; some WebViews do for touch).
 * Scoped to the outermost container that saw the swipe so stale guards never leak
 * into unrelated trees.
 */
let clickGuard: { readonly container: HTMLElement; readonly until: number } | null = null;

function armClickGuard(container: HTMLElement): void {
  const now = Date.now();
  if (clickGuard && clickGuard.until >= now && clickGuard.container !== container && clickGuard.container.contains(container)) {
    clickGuard = { container: clickGuard.container, until: now + CLICK_GUARD_MS };
    return;
  }
  clickGuard = { container, until: now + CLICK_GUARD_MS };
}

function findHorizontalScrollAncestor(target: EventTarget | null, boundary: HTMLElement | null): HTMLElement | null {
  if (typeof window === 'undefined') return null;
  let el: Element | null = target instanceof Element ? target : null;
  while (el && el !== boundary) {
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 4) {
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
 * Whether a gesture starting on `target` at `clientX` must be ignored by the swipe
 * container `container`:
 * - outer 24 px viewport edges (Android edge-back gesture);
 * - events bubbling through the React tree out of a portal (`Dialog`, `BottomSheet`)
 *   whose DOM target is not inside the container;
 * - overlays nested between the target and the container (dialogs, sheets, menus) —
 *   unless the container itself lives in that overlay (e.g. the Player SideSheet tabs);
 * - text fields, sliders, `contenteditable` and `[data-no-tab-swipe]` opt-outs.
 */
function isIgnoredSwipeStart(target: EventTarget | null, container: HTMLElement, clientX: number): boolean {
  if (typeof window !== 'undefined' && window.innerWidth > 200) {
    if (clientX <= EDGE_GUARD_PX || clientX >= window.innerWidth - EDGE_GUARD_PX) return true;
  }
  if (typeof Node !== 'undefined' && target instanceof Node && !container.contains(target)) return true;
  if (!(target instanceof Element)) return false;
  const overlay = target.closest(OVERLAY_SELECTOR);
  if (overlay && overlay !== container && container.contains(overlay)) return true;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
}

/**
 * Horizontal touch/pointer swipe hook for switching between ordered tabs (`order`).
 * - Swiping left (`dx < 0`, right-to-left) advances to the next tab (`idx + 1`).
 * - Swiping right (`dx > 0`, left-to-right) returns to the previous tab (`idx - 1`).
 * - Nests like Android ViewPager2: an inner strip that can move claims the gesture;
 *   at its edge the gesture falls through to the enclosing strip — one swipe never
 *   switches two levels, and the user is never trapped inside an inner strip.
 * - Attaches a native `{ passive: false }` `touchmove` listener during active touches
 *   so Android WebView never cancels (`touchcancel`) horizontal swipes on blank areas.
 * - Ignores touches starting within 24 px of the viewport left/right edge so
 *   Android full-screen edge-back gestures never accidentally switch tabs.
 * - Ignores portaled overlays, inputs/sliders, and horizontally scrollable bars that
 *   can still scroll in the swipe direction.
 * - Swallows the trailing `click` of a committed horizontal swipe so dragging across
 *   a cover card switches tabs without also opening the card.
 */
export function useTabSwipe<T extends string>(
  order: readonly T[],
  value: T,
  onChange: (next: T, direction: TabSwipeDirection) => void,
  options: TabSwipeOptions = {},
): TabSwipeHandlers {
  const enabled = options.enabled ?? true;
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
  useEffect(() => {
    if (enabled) return;
    stateRef.current = null;
    detachWindowTouchMove();
  }, [enabled]);

  const commitSwipe = (s: SwipeStartState, endX: number, endY: number, container: HTMLElement, nativeEvent: Event): void => {
    const dx = endX - s.startX;
    const dy = endY - s.startY;
    if (s.locked === 'y') return;
    if (canScrollHorizontallyInDirection(s.scrollableEl, dx, s.startScrollLeft)) return;
    if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dx) <= Math.abs(dy) * SWIPE_AXIS_RATIO) return;
    // A deliberate horizontal swipe is never a tap, even at the outermost edge.
    armClickGuard(container);
    if (claimedSwipeEvents.has(nativeEvent)) return;
    const idx = order.indexOf(value);
    if (idx < 0) return;
    if (dx < 0 && idx < order.length - 1) {
      claimedSwipeEvents.add(nativeEvent);
      onChange(order[idx + 1]!, 'next');
    } else if (dx > 0 && idx > 0) {
      claimedSwipeEvents.add(nativeEvent);
      onChange(order[idx - 1]!, 'prev');
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
          Math.abs(dx) > Math.abs(dy) * SWIPE_AXIS_RATIO
        ) {
          s.locked = 'x';
        } else if (Math.abs(dy) > Math.abs(dx) * SWIPE_AXIS_RATIO) {
          s.locked = 'y';
        }
      }
    }
  };

  const beginSwipe = (target: EventTarget | null, container: HTMLElement, clientX: number, clientY: number, pointerId?: number): void => {
    const scrollableEl = findHorizontalScrollAncestor(target, container);
    stateRef.current = {
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      locked: null,
      scrollableEl,
      startScrollLeft: scrollableEl ? scrollableEl.scrollLeft : 0,
      pointerId,
    };
  };

  const onTouchStart = (e: TouchEvent<HTMLElement>): void => {
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    clickGuard = null;
    detachWindowTouchMove();
    if (e.touches.length !== 1) {
      stateRef.current = null;
      return;
    }
    const t = e.touches[0]!;
    if (isIgnoredSwipeStart(e.target, e.currentTarget, t.clientX)) {
      stateRef.current = null;
      return;
    }
    beginSwipe(e.target, e.currentTarget, t.clientX, t.clientY);

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
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    if (!stateRef.current) return;
    if (e.touches.length !== 1) {
      // A second finger joined (pinch): abandon the swipe.
      stateRef.current = null;
      detachWindowTouchMove();
      return;
    }
    const t = e.touches[0]!;
    updateMoveLock(stateRef.current, t.clientX, t.clientY);
  };

  const onTouchEnd = (e: TouchEvent<HTMLElement>): void => {
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    detachWindowTouchMove();
    const s = stateRef.current;
    stateRef.current = null;
    if (!s) return;
    const changed = e.changedTouches?.[0];
    const endX = changed ? changed.clientX : s.lastX;
    const endY = changed ? changed.clientY : s.lastY;
    commitSwipe(s, endX, endY, e.currentTarget, e.nativeEvent);
  };

  const onTouchCancel = (e: TouchEvent<HTMLElement>): void => {
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    detachWindowTouchMove();
    const s = stateRef.current;
    stateRef.current = null;
    // Android WebView may cancel a horizontal pan it decided not to scroll: still honour it.
    if (s && s.locked === 'x') {
      commitSwipe(s, s.lastX, s.lastY, e.currentTarget, e.nativeEvent);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled) return;
    if (e.pointerType === 'touch' || Date.now() - lastTouchTimeRef.current < 500) return;
    clickGuard = null;
    if (e.button !== 0 || isIgnoredSwipeStart(e.target, e.currentTarget, e.clientX)) {
      stateRef.current = null;
      return;
    }
    beginSwipe(e.target, e.currentTarget, e.clientX, e.clientY, e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled) return;
    if (e.pointerType === 'touch' || !stateRef.current || stateRef.current.pointerId !== e.pointerId) return;
    updateMoveLock(stateRef.current, e.clientX, e.clientY);
  };

  const onPointerUp = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled) return;
    if (e.pointerType === 'touch' || !stateRef.current || stateRef.current.pointerId !== e.pointerId) return;
    const s = stateRef.current;
    stateRef.current = null;
    commitSwipe(s, e.clientX, e.clientY, e.currentTarget, e.nativeEvent);
  };

  const onPointerCancel = (e: PointerEvent<HTMLElement>): void => {
    if (e.pointerType === 'touch') return;
    stateRef.current = null;
  };

  const onClickCapture = (e: MouseEvent<HTMLElement>): void => {
    const guard = clickGuard;
    if (!guard) return;
    if (Date.now() > guard.until) {
      clickGuard = null;
      return;
    }
    if (!(e.target instanceof Node) || !guard.container.contains(e.target)) return;
    clickGuard = null;
    e.stopPropagation();
    e.preventDefault();
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
    onClickCapture,
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
