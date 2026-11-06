/**
 * Motion primitives for the ViewPager2-style `<TabPager>` (see TabPager.tsx).
 *
 * - **Drag**: while a horizontal swipe is in progress the active slide and the
 *   adjacent slide follow the finger side by side via inline
 *   `transform: translate3d(…)` written straight to the DOM (no React re-render per
 *   `touchmove` / `pointermove` frame).
 * - **Settle**: a released drag glides both slides to their final positions with a
 *   CSS `transition` — the committed neighbour slides fully in while the old page
 *   slides fully out, or both glide back when the drag did not commit. Tab bar /
 *   nav taps play the same side-by-side slide from rest.
 *
 * Every effect is transient: once the motion settles (`transitionend`, or a fallback
 * timer since it never fires in jsdom) the inline `transform` / `transition` /
 * `will-change` are removed and non-active slides unmount. A non-`none` transform (or
 * `will-change: transform`) at rest would turn the slide into the containing block of
 * `position: fixed` descendants such as the immersive player.
 */
/** `'next'` = swipe left (`dx < 0`, idx + 1); `'prev'` = swipe right (`dx > 0`, idx - 1). */
export type TabSwipeDirection = 'next' | 'prev';

/** Snap-back duration (ms), M3 `short4`. */
export const SNAP_BACK_MS = 200;
/** Full-width page slide duration (ms); shorter when a drag already covered part of the way. */
export const TAB_SLIDE_MS = 260;
/** Shortest commit glide (ms), for releases close to the end of the travel. */
export const TAB_SLIDE_MIN_MS = 120;
/** Extra slack before the fallback timer force-settles a motion whose `transitionend` never fired. */
export const FALLBACK_SLACK_MS = 80;
/** Outermost-edge rubber band: damping factor and maximum displacement (px). */
export const RUBBER_BAND_FACTOR = 0.2;
export const RUBBER_BAND_MAX_PX = 36;
/** M3 standard easing (snap-back). */
export const EASING_STANDARD = 'var(--md-sys-motion-easing-standard, cubic-bezier(0.2, 0, 0, 1))';
/** M3 emphasized-decelerate easing (page slide / commit). */
export const EASING_EMPHASIZED_DECELERATE = 'var(--md-sys-motion-easing-emphasized-decelerate, cubic-bezier(0.05, 0.7, 0.1, 1))';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/** Damped displacement for a drag past the outermost tab (`dx * 0.2`, clamped to ±36 px). */
export function rubberBand(dx: number): number {
  const v = dx * RUBBER_BAND_FACTOR;
  return Math.max(-RUBBER_BAND_MAX_PX, Math.min(RUBBER_BAND_MAX_PX, v));
}

const round = (px: number): number => Math.round(px * 100) / 100 + 0; // `+ 0` folds -0 into 0

/**
 * `translate3d` for a slide sitting `pageOffset` whole pages (-1, 0, +1) away from the
 * viewport, displaced by `px`: `translate3d(-120px, 0, 0)`,
 * `translate3d(calc(100% - 120px), 0, 0)`, `translate3d(-100%, 0, 0)`.
 */
export function slideTransform(pageOffset: number, px: number): string {
  const d = round(px);
  if (pageOffset === 0) return `translate3d(${d}px, 0, 0)`;
  const base = `${pageOffset * 100}%`;
  if (d === 0) return `translate3d(${base}, 0, 0)`;
  return `translate3d(calc(${base} ${d < 0 ? '-' : '+'} ${Math.abs(d)}px), 0, 0)`;
}

/** Writes a motion frame on `el` (`transition: none` while the finger drives it). */
export function setSlideFrame(el: HTMLElement, transform: string, transition = 'none'): void {
  el.style.transition = transition;
  el.style.willChange = 'transform';
  el.style.transform = transform;
}

/** Removes every trace of motion from `el` (inline transform / transition / will-change). */
export function clearSlideMotion(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.style.removeProperty('transform');
  el.style.removeProperty('transition');
  el.style.removeProperty('will-change');
  if (el.getAttribute('style') === '') el.removeAttribute('style');
}

/**
 * Current horizontal translation (px) of `el` as rendered — mid-transition this is the
 * interpolated value — used to retarget an interrupted slide without a jump. `0` when
 * unknown (no layout engine, e.g. jsdom).
 */
export function currentTranslateX(el: HTMLElement | null | undefined): number {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0;
  const t = window.getComputedStyle(el).transform;
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (m3) return Number(m3[1]!.split(',')[12]) || 0;
  const m2 = /^matrix\(([^)]+)\)$/.exec(t);
  if (m2) return Number(m2[1]!.split(',')[4]) || 0;
  const px = /^translate3d\((-?[\d.]+)px,/.exec(t);
  if (px) return Number(px[1]) || 0;
  return 0;
}

/**
 * Commit glide duration: the remaining fraction of the page width scales the full
 * slide duration (a release near the end finishes quickly), within
 * [`TAB_SLIDE_MIN_MS`, `TAB_SLIDE_MS`]. Without a measurable width (jsdom) the full
 * duration is used.
 */
export function slideDurationMs(travelledPx: number, widthPx: number): number {
  if (!(widthPx > 0)) return TAB_SLIDE_MS;
  const remaining = 1 - Math.min(1, Math.abs(travelledPx) / widthPx);
  return Math.round(Math.max(TAB_SLIDE_MIN_MS, Math.min(TAB_SLIDE_MS, TAB_SLIDE_MS * remaining)));
}
