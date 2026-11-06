/**
 * Imperative, GPU-composited motion for horizontally swipeable tab panes.
 *
 * - **Drag**: while a horizontal swipe is in progress the pane follows the finger via
 *   an inline `transform: translate3d(dx, 0, 0)` written straight to the DOM (no React
 *   re-render per `touchmove` / `pointermove` frame).
 * - **Snap-back**: a released / cancelled drag that did not switch tabs glides back to
 *   rest with a short M3 standard-easing `transition`.
 * - **Slide**: a tab switch (swipe commit or tab bar tap) plays a directional
 *   `[data-tab-slide="next" | "prev"]` keyframe animation on the pane (see styles.css).
 *
 * Every effect is transient: once the motion settles (`transitionend` /
 * `animationend`, or a fallback timer since neither fires in jsdom or under
 * `prefers-reduced-motion`) the inline `transform` / `transition` / `will-change` and
 * the `data-tab-slide` attribute are removed again. A non-`none` transform (or
 * `will-change: transform`) at rest would turn the pane into the containing block of
 * `position: fixed` descendants such as the immersive player.
 */
/** `'next'` = swipe left (`dx < 0`, idx + 1); `'prev'` = swipe right (`dx > 0`, idx - 1). */
export type TabSwipeDirection = 'next' | 'prev';

/** Attribute driving the directional slide-in keyframes. */
export const TAB_SLIDE_ATTR = 'data-tab-slide';
/** Snap-back duration (ms), M3 `short4`. */
export const SNAP_BACK_MS = 200;
/** Slide-in duration (ms); keep in sync with `--k-tab-slide-duration` in styles.css. */
export const TAB_SLIDE_MS = 260;
/** Extra slack before the fallback timer force-clears a motion whose end event never fired. */
const FALLBACK_SLACK_MS = 80;
/** Outermost-edge rubber band: damping factor and maximum displacement (px). */
export const RUBBER_BAND_FACTOR = 0.2;
export const RUBBER_BAND_MAX_PX = 36;

interface PaneMotion {
  timer: ReturnType<typeof setTimeout> | null;
  detach: (() => void) | null;
}

const motions = new WeakMap<HTMLElement, PaneMotion>();

function motionOf(el: HTMLElement): PaneMotion {
  let m = motions.get(el);
  if (!m) {
    m = { timer: null, detach: null };
    motions.set(el, m);
  }
  return m;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

function stopPending(el: HTMLElement): void {
  const m = motions.get(el);
  if (!m) return;
  if (m.timer !== null) clearTimeout(m.timer);
  m.timer = null;
  m.detach?.();
  m.detach = null;
}

/** Removes every trace of drag / snap-back / slide motion from `el` immediately. */
export function clearPaneMotion(el: HTMLElement | null | undefined): void {
  if (!el) return;
  stopPending(el);
  el.style.removeProperty('transform');
  el.style.removeProperty('transition');
  el.style.removeProperty('will-change');
  el.removeAttribute(TAB_SLIDE_ATTR);
}

/** Damped displacement for a drag past the outermost tab (`dx * 0.2`, clamped to ±36 px). */
export function rubberBand(dx: number): number {
  const v = dx * RUBBER_BAND_FACTOR;
  return Math.max(-RUBBER_BAND_MAX_PX, Math.min(RUBBER_BAND_MAX_PX, v));
}

/**
 * Moves `el` to a horizontal drag offset. `0` clears the inline transform entirely
 * (the pane is at rest, so it must not keep a containing-block-creating transform).
 */
export function setPaneDragOffset(el: HTMLElement, px: number): void {
  if (px === 0) {
    clearPaneMotion(el);
    return;
  }
  // A drag interrupts any running slide-in / snap-back (CSS animations would
  // otherwise override the inline transform).
  stopPending(el);
  el.removeAttribute(TAB_SLIDE_ATTR);
  el.style.transition = 'none';
  el.style.willChange = 'transform';
  el.style.transform = `translate3d(${Math.round(px * 100) / 100}px, 0, 0)`;
}

/** Whether `el` currently carries a drag offset (inline transform). */
export function hasPaneDragOffset(el: HTMLElement): boolean {
  return el.style.transform !== '';
}

function settleLater(el: HTMLElement, ms: number, eventName: 'transitionend' | 'animationend', done: () => void): void {
  const m = motionOf(el);
  const finish = (): void => {
    stopPending(el);
    done();
  };
  const onEnd = (e: Event): void => {
    if (e.target !== el) return; // ignore descendants' transitions / animations
    finish();
  };
  el.addEventListener(eventName, onEnd);
  el.addEventListener(eventName === 'transitionend' ? 'transitioncancel' : 'animationcancel', onEnd);
  m.detach = () => {
    el.removeEventListener(eventName, onEnd);
    el.removeEventListener(eventName === 'transitionend' ? 'transitioncancel' : 'animationcancel', onEnd);
  };
  m.timer = setTimeout(finish, ms + FALLBACK_SLACK_MS);
}

/**
 * Glides a dragged pane back to rest (`dx → 0`) and then clears every inline style.
 * No-op for a pane that is not displaced; instant under `prefers-reduced-motion`.
 */
export function snapBackPane(el: HTMLElement | null | undefined): void {
  if (!el) return;
  // A running slide-in owns the pane; a pane at rest has nothing to undo.
  if (el.hasAttribute(TAB_SLIDE_ATTR) || !hasPaneDragOffset(el)) return;
  stopPending(el);
  if (prefersReducedMotion()) {
    clearPaneMotion(el);
    return;
  }
  el.style.transition = `transform ${SNAP_BACK_MS}ms var(--md-sys-motion-easing-standard, cubic-bezier(0.2, 0, 0, 1))`;
  el.style.transform = 'translate3d(0px, 0, 0)';
  settleLater(el, SNAP_BACK_MS, 'transitionend', () => clearPaneMotion(el));
}

/**
 * Plays the directional slide-in on `el` (`'next'` enters from the right, `'prev'`
 * from the left), restarting it cleanly when called again mid-animation.
 */
export function startPaneSlide(el: HTMLElement | null | undefined, direction: TabSwipeDirection): void {
  if (!el) return;
  clearPaneMotion(el);
  if (prefersReducedMotion()) return;
  // Force a style flush so re-adding the attribute restarts the keyframes even when
  // the previous slide (same direction) has not finished yet.
  void el.offsetWidth;
  el.setAttribute(TAB_SLIDE_ATTR, direction);
  settleLater(el, TAB_SLIDE_MS, 'animationend', () => el.removeAttribute(TAB_SLIDE_ATTR));
}
