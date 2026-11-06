/**
 * `<TabPager>`: Android ViewPager2-style horizontal pager for swipeable tabs.
 *
 * - **At rest** only the active tab's slide is mounted, with no inline transform /
 *   transition / will-change and no motion attributes (a transform at rest would trap
 *   `position: fixed` descendants such as the immersive player).
 * - **Drag** (driven by `useTabSwipe({ pager })`): the adjacent tab in the drag
 *   direction mounts right next to the active one (`+100%` for next, `-100%` for prev)
 *   and both follow the finger 1:1 via DOM-only `translate3d` writes — the only React
 *   render is the one that mounts (or, when the finger crosses its start point,
 *   swaps) the neighbour. Past the outermost tab the active slide rubber-bands alone.
 * - **Release**: a committed swipe glides both slides on from the exact release
 *   position (old page fully out, new page fully in); otherwise both glide back and the
 *   neighbour unmounts once settled.
 * - **Programmatic change** (tab bar / nav tap, Android back): the old and the new page
 *   slide side by side, even across several tabs (`anime` → `settings` never shows the
 *   pages in between). A change mid-flight retargets from the current position.
 * - Slides are keyed by tab value in tab order, so a peeked neighbour that becomes the
 *   active page keeps its exact fiber and DOM (no remount, scroll reset or flicker).
 * - Non-active slides are `inert`, `aria-hidden` and publish
 *   `InactiveTabSlideContext` so they never steal focus, back presses or ARIA queries.
 * - `enabled={false}` (or `prefers-reduced-motion: reduce`) drops motion at once.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';
import {
  EASING_EMPHASIZED_DECELERATE,
  EASING_STANDARD,
  FALLBACK_SLACK_MS,
  SNAP_BACK_MS,
  clearSlideMotion,
  currentTranslateX,
  prefersReducedMotion,
  setSlideFrame,
  slideDurationMs,
  slideTransform,
  type TabSwipeDirection,
} from './tabMotion';
import { InactiveTabSlideContext } from './tabSlideContext';

/** How a mounted slide relates to the active page. */
export interface TabPagerSlide {
  /** Whether this is the active (current) tab's slide. */
  readonly active: boolean;
  /** `'neighbor'`: peeked during a drag; `'outgoing'`: the old page sliding out. */
  readonly role: 'active' | 'neighbor' | 'outgoing';
  /** Side of the active page this slide sits on (`null` for the active slide). */
  readonly side: TabSwipeDirection | null;
}

interface Peer<T extends string> {
  readonly tab: T;
  readonly side: TabSwipeDirection;
  readonly role: 'neighbor' | 'outgoing';
}

/** Imperative motion API that `useTabSwipe` drives; implemented by the mounted `<TabPager>`. */
export interface TabPagerDriver {
  /**
   * One drag frame. `follow`: the strip can switch tabs in `offset`'s direction, so the
   * neighbour is revealed and both slides follow `offset` 1:1; otherwise `offset` is an
   * already damped rubber-band displacement of the active slide alone.
   */
  drag(offset: number, follow: boolean): void;
  /** The drag ended without switching tabs: glide everything back, then unmount the neighbour. */
  release(): void;
  /** The drag is about to commit (`onChange` follows): the commit glide starts from the current offset. */
  prepareCommit(): void;
  /** Drop every motion immediately (another strip took the gesture over, or swiping got disabled). */
  reset(): void;
}

/** Stable handle connecting `useTabSwipe({ pager })` to `<TabPager pager>`. */
export interface TabPagerController {
  driver: TabPagerDriver | null;
}

/** Creates the stable controller shared by `useTabSwipe` and `<TabPager>`. */
export function useTabPager(): TabPagerController {
  const [controller] = useState<TabPagerController>(() => ({ driver: null }));
  return controller;
}

export interface TabPagerProps<T extends string> extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onChange'> {
  readonly pager: TabPagerController;
  /** Tab order (swiping left reveals the next one). */
  readonly order: readonly T[];
  /** Active tab. */
  readonly value: T;
  /** When `false`, motion is dropped at once and tab changes swap instantly. Default `true`. */
  readonly enabled?: boolean;
  /**
   * `'fill'` (default): the viewport fills its flex parent and each slide is its own
   * scroll container. `'flow'`: the active slide stays in normal flow (the viewport
   * takes its height and the surrounding container scrolls); other slides overlay it.
   */
  readonly layout?: 'fill' | 'flow';
  /** Whether `tab` may be revealed next to the active page while dragging (default: always). */
  readonly peekable?: ((tab: T) => boolean) | undefined;
  readonly slideClassName?: string | undefined;
  /** ARIA role for slides (e.g. `tabpanel`). */
  readonly slideRole?: string | undefined;
  readonly renderPage: (tab: T, slide: TabPagerSlide) => ReactNode;
}

type Phase = 'rest' | 'drag' | 'snap' | 'slide';

interface Motion {
  phase: Phase;
  /** Drag offset (px) of the active slide. */
  dx: number;
  commitPending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  commitGuard: ReturnType<typeof setTimeout> | null;
  detach: (() => void) | null;
}

const samePeer = <T extends string>(a: Peer<T> | null, b: Peer<T> | null): boolean =>
  a === b || (a !== null && b !== null && a.tab === b.tab && a.side === b.side && a.role === b.role);

const pageOffsetOf = (side: TabSwipeDirection): number => (side === 'next' ? 1 : -1);

export function TabPager<T extends string>({
  pager,
  order,
  value,
  enabled = true,
  layout = 'fill',
  peekable,
  slideClassName,
  slideRole,
  renderPage,
  className,
  ...rest
}: TabPagerProps<T>) {
  const parentInactive = useContext(InactiveTabSlideContext);
  const [snap, setSnap] = useState<{ readonly value: T; readonly enabled: boolean }>({ value, enabled });
  const [peerState, setPeerState] = useState<Peer<T> | null>(null);

  // Derive the outgoing slide while rendering the tab change itself, so the old page
  // never unmounts between the change and the start of its slide-out.
  let peer = peerState;
  if (snap.value !== value || snap.enabled !== enabled) {
    if (snap.value !== value) {
      const from = order.indexOf(snap.value);
      const to = order.indexOf(value);
      peer =
        enabled && snap.enabled && from >= 0 && to >= 0 && !prefersReducedMotion()
          ? { tab: snap.value, side: to > from ? 'prev' : 'next', role: 'outgoing' }
          : null;
    } else if (!enabled) {
      peer = null;
    }
    setSnap({ value, enabled });
    if (!samePeer(peer, peerState)) setPeerState(peer);
  } else if (!enabled && peer) {
    peer = null;
    setPeerState(null);
  }

  const viewportRef = useRef<HTMLDivElement>(null);
  const slides = useRef(new Map<T, HTMLElement>()).current;
  const peerRef = useRef<Peer<T> | null>(peer);
  const latest = useRef({ order, value, enabled, peekable });
  const lastValueRef = useRef(value);
  const motion = useRef<Motion>({ phase: 'rest', dx: 0, commitPending: false, timer: null, commitGuard: null, detach: null }).current;

  const [driver] = useState(() => {
    const stop = (): void => {
      if (motion.timer !== null) clearTimeout(motion.timer);
      motion.timer = null;
      motion.detach?.();
      motion.detach = null;
    };
    const requestPeer = (next: Peer<T> | null): void => {
      if (samePeer(peerRef.current, next)) return;
      peerRef.current = next;
      setPeerState(next);
    };
    /** Back at rest: clean active slide, non-active slides unmount (they are parked off-screen). */
    const rest = (): void => {
      stop();
      motion.phase = 'rest';
      motion.dx = 0;
      motion.commitPending = false;
      clearSlideMotion(slides.get(latest.current.value));
      requestPeer(null);
    };
    const settleLater = (el: HTMLElement, ms: number): void => {
      const finish = (): void => rest();
      const onEnd = (e: Event): void => {
        if (e.target === el) finish(); // ignore descendants' transitions
      };
      el.addEventListener('transitionend', onEnd);
      el.addEventListener('transitioncancel', onEnd);
      motion.detach = () => {
        el.removeEventListener('transitionend', onEnd);
        el.removeEventListener('transitioncancel', onEnd);
      };
      motion.timer = setTimeout(finish, ms + FALLBACK_SLACK_MS);
    };
    /** Writes the current drag frame on the active slide and the revealed neighbour. */
    const apply = (): void => {
      if (motion.phase !== 'drag') return;
      const active = slides.get(latest.current.value);
      if (active) setSlideFrame(active, slideTransform(0, motion.dx));
      const p = peerRef.current;
      if (p && p.role === 'neighbor') {
        const el = slides.get(p.tab);
        if (el) setSlideFrame(el, slideTransform(pageOffsetOf(p.side), motion.dx));
      }
    };
    /**
     * Cancels a running glide (a new drag takes over): the active slide returns to
     * rest, the other slide is parked off-screen on its side until it unmounts or is
     * reused as the drag's neighbour (same key, same instance).
     */
    const interrupt = (): void => {
      stop();
      const { value: v } = latest.current;
      const p = peerRef.current;
      for (const [tab, el] of slides) {
        if (tab === v) clearSlideMotion(el);
        else setSlideFrame(el, slideTransform(p && p.tab === tab ? pageOffsetOf(p.side) : 1, 0));
      }
    };
    const d: TabPagerDriver & {
      apply: () => void;
      rest: () => void;
      stop: () => void;
      settleLater: (el: HTMLElement, ms: number) => void;
    } = {
      apply,
      rest,
      stop,
      settleLater,
      drag(offset, follow) {
        const { order: o, value: v, enabled: on, peekable: canPeek } = latest.current;
        if (!on) return;
        if (motion.phase === 'snap' || motion.phase === 'slide') interrupt();
        motion.phase = 'drag';
        motion.dx = offset;
        motion.commitPending = false;
        let want: Peer<T> | null = null;
        if (follow && offset !== 0) {
          const side: TabSwipeDirection = offset < 0 ? 'next' : 'prev';
          const idx = o.indexOf(v);
          const tab = idx >= 0 ? o[idx + pageOffsetOf(side)] : undefined;
          if (tab !== undefined && (canPeek?.(tab) ?? true)) want = { tab, side, role: 'neighbor' };
        }
        requestPeer(want);
        apply();
      },
      release() {
        if (motion.phase !== 'drag') return;
        motion.commitPending = false;
        const active = slides.get(latest.current.value);
        const p = peerRef.current;
        const neighbor = p && p.role === 'neighbor' ? slides.get(p.tab) : undefined;
        if (!active || motion.dx === 0 || prefersReducedMotion()) {
          rest();
          return;
        }
        stop();
        motion.phase = 'snap';
        const transition = `transform ${SNAP_BACK_MS}ms ${EASING_STANDARD}`;
        setSlideFrame(active, slideTransform(0, 0), transition);
        if (neighbor && p) setSlideFrame(neighbor, slideTransform(pageOffsetOf(p.side), 0), transition);
        settleLater(active, SNAP_BACK_MS);
      },
      prepareCommit() {
        if (motion.phase !== 'drag') return;
        motion.commitPending = true;
        // Safety net: if the owner ignores the change, never leave the slides displaced.
        if (motion.commitGuard !== null) clearTimeout(motion.commitGuard);
        motion.commitGuard = setTimeout(() => {
          motion.commitGuard = null;
          if (motion.commitPending) d.release();
        }, 0);
      },
      reset() {
        if (motion.phase === 'rest' && peerRef.current === null) return;
        interrupt();
        rest();
      },
    };
    return d;
  });

  useLayoutEffect(() => {
    latest.current = { order, value, enabled, peekable };
    peerRef.current = peer;
    pager.driver = driver;
    const from = lastValueRef.current;
    lastValueRef.current = value;
    if (!enabled) {
      driver.stop();
      motion.phase = 'rest';
      motion.dx = 0;
      motion.commitPending = false;
      for (const el of slides.values()) clearSlideMotion(el);
      return;
    }
    if (from !== value) {
      const inEl = slides.get(value);
      const outEl = peer && peer.role === 'outgoing' ? slides.get(peer.tab) : undefined;
      if (!peer || !inEl || !outEl) {
        driver.rest();
        return;
      }
      // Start from where the old page is: the drag release offset, the interpolated
      // position of an interrupted slide, or rest for a tap.
      const startDx =
        motion.commitPending || motion.phase === 'drag' ? motion.dx : motion.phase === 'slide' ? currentTranslateX(outEl) : 0;
      driver.stop();
      motion.phase = 'slide';
      motion.dx = 0;
      motion.commitPending = false;
      const outTarget = pageOffsetOf(peer.side);
      setSlideFrame(outEl, slideTransform(0, startDx));
      setSlideFrame(inEl, slideTransform(-outTarget, startDx));
      const width = viewportRef.current?.clientWidth ?? 0; // also flushes the start frame
      const ms = slideDurationMs(startDx, width);
      const transition = `transform ${ms}ms ${startDx === 0 ? EASING_STANDARD : EASING_EMPHASIZED_DECELERATE}`;
      setSlideFrame(outEl, slideTransform(outTarget, 0), transition);
      setSlideFrame(inEl, slideTransform(0, 0), transition);
      driver.settleLater(inEl, ms);
      return;
    }
    driver.apply();
  });

  useEffect(
    () => () => {
      driver.stop();
      if (motion.commitGuard !== null) clearTimeout(motion.commitGuard);
      motion.commitGuard = null;
      if (pager.driver === driver) pager.driver = null;
    },
    [driver, pager],
  );

  const mounted: T[] = peer && peer.tab !== value ? [value, peer.tab] : [value];
  mounted.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return (
    <div
      {...rest}
      ref={viewportRef}
      className={cx('k-pager', `k-pager--${layout}`, className)}
      data-pager-moving={mounted.length > 1 ? '' : undefined}
    >
      {mounted.map((tab) => {
        const active = tab === value;
        const slide: TabPagerSlide = active
          ? { active: true, role: 'active', side: null }
          : { active: false, role: peer!.role, side: peer!.side };
        return (
          <div
            key={tab}
            ref={(el) => {
              if (!el) return;
              slides.set(tab, el);
              return () => {
                if (slides.get(tab) === el) slides.delete(tab);
              };
            }}
            className={cx('k-pager__slide', slideClassName)}
            role={slideRole}
            data-pager-tab={tab}
            data-pager-peer={active ? undefined : slide.side!}
            aria-hidden={active ? undefined : true}
            inert={active ? undefined : true}
          >
            <InactiveTabSlideContext.Provider value={parentInactive || !active}>
              {renderPage(tab, slide)}
            </InactiveTabSlideContext.Provider>
          </div>
        );
      })}
    </div>
  );
}
