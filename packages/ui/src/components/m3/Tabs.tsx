/** M3 primary tabs with an animated active indicator and horizontal swipe hook. */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  type TouchEvent,
} from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';
import {
  clearPaneMotion,
  rubberBand,
  setPaneDragOffset,
  snapBackPane,
  startPaneSlide,
  type TabSwipeDirection,
} from './tabMotion';

export type { TabSwipeDirection } from './tabMotion';

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
  /** The swipe container (`currentTarget`) that saw the gesture start. */
  readonly container: HTMLElement;
}

export interface TabSwipeOptions {
  /** When `false` every handler is inert (e.g. the Shell swipe inside Player / Reader). Default `true`. */
  readonly enabled?: boolean;
  /**
   * The pane that visually belongs to the active tab: it follows the finger during a
   * horizontal drag (rubber-banding past the outermost tab, gliding back when the
   * drag does not commit) and plays the directional slide-in whenever `value`
   * changes while enabled (swipe commit, tab bar tap, back navigation). Without it
   * drags move the swipe container itself and tab changes are not animated.
   */
  readonly paneRef?: RefObject<HTMLElement | null> | undefined;
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
 * Native move events whose drag offset was already claimed by an inner strip. Mirrors
 * `claimedSwipeEvents` for the live finger-following drag, so exactly one pane — the
 * innermost one that can move in `dx`'s direction — translates on every frame.
 */
const claimedDragEvents = new WeakSet<Event>();

/** Gestures currently tracked by any `useTabSwipe` (to find the outermost strip). */
const activeSwipes = new Set<SwipeStartState>();

/** Whether an enclosing strip is tracking the same gesture (then it owns the rubber band). */
function hasActiveOuterSwipe(s: SwipeStartState): boolean {
  for (const o of activeSwipes) {
    if (o !== s && o.container !== s.container && o.container.contains(s.container)) return true;
  }
  return false;
}

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
 * - With `options.paneRef`: the pane follows the finger (DOM-only `translate3d`, no
 *   re-render per frame) on the single innermost strip that can move — the outermost
 *   strip rubber-bands at its ends — glides back when the drag does not commit, and
 *   slides in from the right (`next`) / left (`prev`) on every tab change.
 */
export function useTabSwipe<T extends string>(
  order: readonly T[],
  value: T,
  onChange: (next: T, direction: TabSwipeDirection) => void,
  options: TabSwipeOptions = {},
): TabSwipeHandlers {
  const enabled = options.enabled ?? true;
  const paneRef = options.paneRef;
  const stateRef = useRef<SwipeStartState | null>(null);
  const lastTouchTimeRef = useRef(0);
  const cleanupWindowListenersRef = useRef<(() => void) | null>(null);
  /** The pane this hook displaced during the current drag (to glide back / clear). */
  const draggedPaneRef = useRef<HTMLElement | null>(null);
  /** The last pane this hook animated (cleared on unmount). */
  const animatedPaneRef = useRef<HTMLElement | null>(null);
  const prevValueRef = useRef(value);
  const prevEnabledRef = useRef(enabled);

  const paneOf = (s: SwipeStartState | null): HTMLElement | null =>
    paneRef ? paneRef.current : (s?.container ?? null);

  const detachWindowListeners = (): void => {
    if (cleanupWindowListenersRef.current) {
      cleanupWindowListenersRef.current();
      cleanupWindowListenersRef.current = null;
    }
  };

  /** Stops tracking the current gesture (if any) and returns it. */
  const endState = (): SwipeStartState | null => {
    const s = stateRef.current;
    stateRef.current = null;
    if (s) activeSwipes.delete(s);
    detachWindowListeners();
    return s;
  };

  /** Settles the displaced pane: cleared at once on commit (the slide-in takes over), else glides back. */
  const releasePane = (committed: boolean): void => {
    const pane = draggedPaneRef.current;
    draggedPaneRef.current = null;
    if (!pane) return;
    if (committed) clearPaneMotion(pane);
    else snapBackPane(pane);
  };

  /** Ends the gesture without switching tabs (pinch, cancel, lost release). */
  const abandonGesture = (): void => {
    endState();
    releasePane(false);
  };

  useEffect(
    () => () => {
      const s = stateRef.current;
      stateRef.current = null;
      if (s) activeSwipes.delete(s);
      detachWindowListeners();
      clearPaneMotion(draggedPaneRef.current);
      clearPaneMotion(animatedPaneRef.current);
      draggedPaneRef.current = null;
      animatedPaneRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (enabled) return;
    endState();
    clearPaneMotion(draggedPaneRef.current);
    draggedPaneRef.current = null;
  }, [enabled]);

  // Directional slide-in on every tab change while enabled (in both renders: entering
  // the strip — e.g. opening Nyaa Stage 2 or leaving the player — is not a tab change).
  // Disabled strips never keep motion on their pane (the Shell's pane is the ancestor
  // of the immersive player, whose `position: fixed` a transform would trap).
  useLayoutEffect(() => {
    const prev = prevValueRef.current;
    const wasEnabled = prevEnabledRef.current;
    prevValueRef.current = value;
    prevEnabledRef.current = enabled;
    const pane = paneRef?.current ?? null;
    if (!enabled) {
      clearPaneMotion(pane);
      clearPaneMotion(animatedPaneRef.current);
      animatedPaneRef.current = null;
      return;
    }
    if (prev === value || !wasEnabled || !pane) return;
    const from = order.indexOf(prev);
    const to = order.indexOf(value);
    if (from < 0 || to < 0) return;
    animatedPaneRef.current = pane;
    startPaneSlide(pane, to > from ? 'next' : 'prev');
  }, [value, enabled]);

  /** Whether this strip can switch tabs in `dx`'s direction. */
  const canMove = (dx: number): boolean => {
    const idx = order.indexOf(value);
    if (idx < 0) return false;
    return (dx < 0 && idx < order.length - 1) || (dx > 0 && idx > 0);
  };

  /**
   * Returns `true` when this hook switched tabs. The pane stays where the finger left
   * it until the caller settles it via `releasePane`.
   */
  const commitSwipe = (s: SwipeStartState, endX: number, endY: number, container: HTMLElement, nativeEvent: Event): boolean => {
    const dx = endX - s.startX;
    const dy = endY - s.startY;
    if (s.locked === 'y') return false;
    if (canScrollHorizontallyInDirection(s.scrollableEl, dx, s.startScrollLeft)) return false;
    if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dx) <= Math.abs(dy) * SWIPE_AXIS_RATIO) return false;
    // A deliberate horizontal swipe is never a tap, even at the outermost edge.
    armClickGuard(container);
    if (claimedSwipeEvents.has(nativeEvent)) return false;
    const idx = order.indexOf(value);
    if (idx < 0) return false;
    if (dx < 0 && idx < order.length - 1) {
      claimedSwipeEvents.add(nativeEvent);
      onChange(order[idx + 1]!, 'next');
      return true;
    }
    if (dx > 0 && idx > 0) {
      claimedSwipeEvents.add(nativeEvent);
      onChange(order[idx - 1]!, 'prev');
      return true;
    }
    return false;
  };

  /** Ends the gesture at (`endX`, `endY`): switches tabs if warranted, then settles the pane. */
  const finishGesture = (endX: number, endY: number, container: HTMLElement, nativeEvent: Event): void => {
    const s = endState();
    if (!s) return;
    const committed = commitSwipe(s, endX, endY, container, nativeEvent);
    releasePane(committed);
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

  /**
   * Finger-following drag for one move event. React dispatches it innermost-first, so
   * the innermost strip that can move in `dx`'s direction claims the frame and
   * translates its pane; strips at their edge stay at rest and let it fall through;
   * the outermost strip with nowhere to go rubber-bands.
   */
  const trackDrag = (s: SwipeStartState, nativeEvent: Event): void => {
    if (s.locked !== 'x') return;
    const dx = s.lastX - s.startX;
    let offset = 0;
    if (!claimedDragEvents.has(nativeEvent) && !canScrollHorizontallyInDirection(s.scrollableEl, dx, s.startScrollLeft)) {
      if (canMove(dx)) offset = dx;
      else if (!hasActiveOuterSwipe(s)) offset = rubberBand(dx);
      if (offset !== 0) claimedDragEvents.add(nativeEvent);
    }
    const previous = draggedPaneRef.current;
    if (offset === 0) {
      if (previous) {
        clearPaneMotion(previous);
        draggedPaneRef.current = null;
      }
      return;
    }
    const pane = paneOf(s);
    if (!pane) return;
    if (previous && previous !== pane) clearPaneMotion(previous);
    draggedPaneRef.current = pane;
    setPaneDragOffset(pane, offset);
  };

  const beginSwipe = (target: EventTarget | null, container: HTMLElement, clientX: number, clientY: number, pointerId?: number): SwipeStartState => {
    endState();
    // A new gesture takes over a pane still gliding back from the previous one.
    if (draggedPaneRef.current) {
      clearPaneMotion(draggedPaneRef.current);
      draggedPaneRef.current = null;
    }
    const scrollableEl = findHorizontalScrollAncestor(target, container);
    const s: SwipeStartState = {
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      locked: null,
      scrollableEl,
      startScrollLeft: scrollableEl ? scrollableEl.scrollLeft : 0,
      pointerId,
      container,
    };
    stateRef.current = s;
    activeSwipes.add(s);
    return s;
  };

  const onTouchStart = (e: TouchEvent<HTMLElement>): void => {
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    clickGuard = null;
    if (e.touches.length !== 1) {
      abandonGesture();
      return;
    }
    const t = e.touches[0]!;
    if (isIgnoredSwipeStart(e.target, e.currentTarget, t.clientX)) {
      abandonGesture();
      return;
    }
    const s = beginSwipe(e.target, e.currentTarget, t.clientX, t.clientY);

    if (typeof window !== 'undefined') {
      const onNativeTouchMove = (ev: globalThis.TouchEvent): void => {
        if (stateRef.current !== s || ev.touches.length !== 1) return;
        const touch = ev.touches[0]!;
        updateMoveLock(s, touch.clientX, touch.clientY);
        if (s.locked === 'x' && ev.cancelable) {
          ev.preventDefault();
        }
      };
      // Safety net: React normally sees the release first; if the touched node was
      // removed mid-gesture the release never reaches React, so never leave the pane
      // displaced.
      const onNativeTouchEnd = (): void => {
        if (stateRef.current === s) abandonGesture();
      };
      window.addEventListener('touchmove', onNativeTouchMove, { passive: false });
      window.addEventListener('touchend', onNativeTouchEnd);
      window.addEventListener('touchcancel', onNativeTouchEnd);
      cleanupWindowListenersRef.current = () => {
        window.removeEventListener('touchmove', onNativeTouchMove);
        window.removeEventListener('touchend', onNativeTouchEnd);
        window.removeEventListener('touchcancel', onNativeTouchEnd);
      };
    }
  };

  const onTouchMove = (e: TouchEvent<HTMLElement>): void => {
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    const s = stateRef.current;
    if (!s) return;
    if (e.touches.length !== 1) {
      // A second finger joined (pinch): abandon the swipe and glide back.
      abandonGesture();
      return;
    }
    const t = e.touches[0]!;
    updateMoveLock(s, t.clientX, t.clientY);
    trackDrag(s, e.nativeEvent);
  };

  const onTouchEnd = (e: TouchEvent<HTMLElement>): void => {
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    const s = stateRef.current;
    if (!s) {
      detachWindowListeners();
      return;
    }
    const changed = e.changedTouches?.[0];
    const endX = changed ? changed.clientX : s.lastX;
    const endY = changed ? changed.clientY : s.lastY;
    finishGesture(endX, endY, e.currentTarget, e.nativeEvent);
  };

  const onTouchCancel = (e: TouchEvent<HTMLElement>): void => {
    if (!enabled) return;
    lastTouchTimeRef.current = Date.now();
    const s = stateRef.current;
    // Android WebView may cancel a horizontal pan it decided not to scroll: still honour it.
    if (s && s.locked === 'x') {
      finishGesture(s.lastX, s.lastY, e.currentTarget, e.nativeEvent);
    } else {
      abandonGesture();
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled) return;
    if (e.pointerType === 'touch' || Date.now() - lastTouchTimeRef.current < 500) return;
    clickGuard = null;
    if (e.button !== 0 || isIgnoredSwipeStart(e.target, e.currentTarget, e.clientX)) {
      abandonGesture();
      return;
    }
    const s = beginSwipe(e.target, e.currentTarget, e.clientX, e.clientY, e.pointerId);
    if (typeof window !== 'undefined') {
      // Safety net for a mouse released outside the container (no React pointerup).
      const onNativePointerEnd = (ev: globalThis.PointerEvent): void => {
        if (stateRef.current === s && ev.pointerId === s.pointerId) abandonGesture();
      };
      window.addEventListener('pointerup', onNativePointerEnd);
      window.addEventListener('pointercancel', onNativePointerEnd);
      cleanupWindowListenersRef.current = () => {
        window.removeEventListener('pointerup', onNativePointerEnd);
        window.removeEventListener('pointercancel', onNativePointerEnd);
      };
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled) return;
    const s = stateRef.current;
    if (e.pointerType === 'touch' || !s || s.pointerId !== e.pointerId) return;
    updateMoveLock(s, e.clientX, e.clientY);
    trackDrag(s, e.nativeEvent);
  };

  const onPointerUp = (e: PointerEvent<HTMLElement>): void => {
    if (!enabled) return;
    if (e.pointerType === 'touch' || !stateRef.current || stateRef.current.pointerId !== e.pointerId) return;
    finishGesture(e.clientX, e.clientY, e.currentTarget, e.nativeEvent);
  };

  const onPointerCancel = (e: PointerEvent<HTMLElement>): void => {
    if (e.pointerType === 'touch') return;
    abandonGesture();
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

/** Horizontal inset (px) of `.k-tabs__indicator` inside its tab (`left` / `right` in styles.css). */
const INDICATOR_INSET_PX = 16;

/**
 * Scrolls only the tab list (never its ancestors — `scrollIntoView` would also scroll
 * the page vertically and, mid slide-in, the transformed shell sideways) so the
 * selected tab is fully visible.
 */
function revealTab(list: HTMLElement, tab: HTMLElement): void {
  if (list.scrollWidth <= list.clientWidth) return;
  const lr = list.getBoundingClientRect();
  const tr = tab.getBoundingClientRect();
  if (tr.left < lr.left) list.scrollLeft += tr.left - lr.left;
  else if (tr.right > lr.right) list.scrollLeft += tr.right - lr.right;
}

/**
 * Slides the active indicator from the previously selected tab to the new one (FLIP:
 * start at the old tab's position / width, transition to rest via the
 * `.is-selected` CSS transition) so tab bar taps and swipes move it continuously.
 */
function slideIndicator(prevTab: HTMLElement, nextTab: HTMLElement): void {
  const indicator = nextTab.querySelector<HTMLElement>('.k-tabs__indicator');
  if (!indicator) return;
  const prevW = prevTab.offsetWidth - 2 * INDICATOR_INSET_PX;
  const nextW = nextTab.offsetWidth - 2 * INDICATOR_INSET_PX;
  if (prevW <= 0 || nextW <= 0) return; // not laid out (jsdom / hidden)
  const shift = prevTab.offsetLeft + prevTab.offsetWidth / 2 - (nextTab.offsetLeft + nextTab.offsetWidth / 2);
  indicator.style.transition = 'none';
  indicator.style.transform = `translateX(${shift}px) scaleX(${prevW / nextW})`;
  void indicator.offsetWidth;
  indicator.style.removeProperty('transition');
  indicator.style.removeProperty('transform');
}

export function Tabs<T extends string>({ tabs, value, onChange, className, label }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const prevValueRef = useRef(value);

  useLayoutEffect(() => {
    const list = listRef.current;
    const prev = prevValueRef.current;
    prevValueRef.current = value;
    if (!list) return;
    const els = list.querySelectorAll<HTMLElement>('.k-tabs__tab');
    const nextTab = els[tabs.findIndex((t) => t.value === value)];
    if (!nextTab) return;
    if (prev !== value) {
      const prevTab = els[tabs.findIndex((t) => t.value === prev)];
      if (prevTab) slideIndicator(prevTab, nextTab);
    }
    revealTab(list, nextTab);
    // `tabs` is a fresh array every render; only selection changes matter.
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
