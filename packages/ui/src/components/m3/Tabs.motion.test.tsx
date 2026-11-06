/**
 * ViewPager2-style `<TabPager>` driven by `useTabSwipe({ pager })`: dual-page
 * finger-following drag, mid-drag reversal, commit / snap-back glides, tab bar slides,
 * interruption, nested strips, rubber band, rest-state cleanup, inactive-slide
 * isolation — and the `<Tabs>` indicator.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchBackNavigation, useBackInterceptor } from '../../app/routes';
import { installPointerEventPolyfill } from '../../test/pointer';
import { resetStores } from '../../test/utils';
import { TabPager, useTabPager, type TabPagerSlide } from './TabPager';
import { Tabs, useTabSwipe } from './Tabs';
import { SNAP_BACK_MS, TAB_SLIDE_MS, slideDurationMs } from './tabMotion';
import { useIsInactiveTabSlide } from './tabSlideContext';

const OUTER = ['a', 'b', 'c'] as const;
const INNER = ['x', 'y', 'z'] as const;
const SETTLE_MS = TAB_SLIDE_MS + 100;

/** Mount / render counters per `<strip>:<tab>` page. */
const mounts = new Map<string, number>();
const renders = new Map<string, number>();
const backLog: string[] = [];
const inactiveSeen = new Map<string, boolean>();

function Page({ id, tab, slide, children }: { id: string; tab: string; slide: TabPagerSlide; children?: ReactNode }) {
  const key = `${id}:${tab}`;
  renders.set(key, (renders.get(key) ?? 0) + 1);
  inactiveSeen.set(key, useIsInactiveTabSlide());
  useEffect(() => {
    mounts.set(key, (mounts.get(key) ?? 0) + 1);
  }, [key]);
  useBackInterceptor(() => {
    backLog.push(key);
    return true;
  });
  return (
    <div className="k-page" data-testid={`page-${key}`} data-role={slide.role}>
      <span>{key}</span>
      {children}
    </div>
  );
}

function Strip<T extends string>({
  id,
  order,
  initial,
  enabled = true,
  inner,
}: {
  id: string;
  order: readonly T[];
  initial: T;
  enabled?: boolean;
  inner?: (tab: T) => ReactNode;
}) {
  const [tab, setTab] = useState<T>(initial);
  const pager = useTabPager();
  // Like DownloadsPage: a strip inside a peeked / exiting slide is a still picture.
  const on = enabled && !useIsInactiveTabSlide();
  const swipe = useTabSwipe<T>(order, tab, (next) => setTab(next), { pager, enabled: on });
  return (
    <div data-testid={id} data-tab={tab} {...swipe}>
      <Tabs<T> label={id} value={tab} onChange={setTab} tabs={order.map((v) => ({ value: v, label: `${id}-${v}` }))} />
      <TabPager<T>
        pager={pager}
        order={order}
        value={tab}
        enabled={on}
        data-testid={`${id}-pager`}
        renderPage={(t, slide) => (
          <Page id={id} tab={t} slide={slide}>
            {inner?.(t)}
          </Page>
        )}
      />
    </div>
  );
}

const pagerEl = (id: string): HTMLElement => screen.getByTestId(`${id}-pager`);
/** Mounted slides of strip `id`, in DOM order, as their tab values. */
const slideEls = (id: string): HTMLElement[] =>
  [...pagerEl(id).children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('k-pager__slide'));
const slideTabs = (id: string): string[] => slideEls(id).map((el) => el.dataset['pagerTab']!);
const slide = (id: string, tab: string): HTMLElement => slideEls(id).find((el) => el.dataset['pagerTab'] === tab)!;
const tx = (id: string, tab: string): string => slide(id, tab).style.transform;
const tabOf = (id: string): string | undefined => screen.getByTestId(id).dataset['tab'];
/** The page element of the active slide (gesture target). */
const activePage = (id: string): HTMLElement =>
  slideEls(id).find((el) => !el.hasAttribute('inert'))!.querySelector<HTMLElement>('.k-page')!;

function touchDown(el: Element, x: number, y = 300): void {
  fireEvent.touchStart(el, { touches: [{ clientX: x, clientY: y }] });
}
function touchTo(el: Element, x: number, y = 300): void {
  fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: y }] });
}
function touchUp(el: Element, x: number, y = 300): void {
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: x, clientY: y }] });
}
function swipe(el: Element, fromX: number, toX: number): void {
  touchDown(el, fromX);
  touchTo(el, (fromX + toX) / 2);
  touchTo(el, toX);
  touchUp(el, toX);
}
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}
/** Asserts strip `id` is at rest: one slide, no inline motion, no motion attributes. */
function expectAtRest(id: string, tab: string): void {
  expect(slideTabs(id)).toEqual([tab]);
  const el = slide(id, tab);
  expect(el.getAttribute('style') ?? '').toBe('');
  expect(el).not.toHaveAttribute('data-pager-peer');
  expect(el).not.toHaveAttribute('aria-hidden');
  expect(el).not.toHaveAttribute('inert');
  expect(pagerEl(id)).not.toHaveAttribute('data-pager-moving');
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('<TabPager> + useTabSwipe', () => {
  let uninstallPointerEvent: () => void = () => {};
  beforeAll(() => {
    uninstallPointerEvent = installPointerEventPolyfill();
  });
  afterAll(() => uninstallPointerEvent());
  beforeEach(() => {
    resetStores();
    mounts.clear();
    renders.clear();
    inactiveSeen.clear();
    backLog.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('dual-page drag', () => {
    it('reveals the next page right of the active one while dragging left; both follow the finger without re-rendering', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      expectAtRest('outer', 'b');
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 395); // within the touch slop: not locked yet
      expect(slideTabs('outer')).toEqual(['b']);
      touchTo(p, 340);
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      expect(tx('outer', 'b')).toBe('translate3d(-60px, 0, 0)');
      expect(tx('outer', 'c')).toBe('translate3d(calc(100% - 60px), 0, 0)');
      expect(slide('outer', 'b').style.willChange).toBe('transform');
      expect(slide('outer', 'c')).toHaveAttribute('data-pager-peer', 'next');
      expect(pagerEl('outer')).toHaveAttribute('data-pager-moving');

      const before = { b: renders.get('outer:b'), c: renders.get('outer:c') };
      touchTo(p, 250);
      touchTo(p, 210);
      expect(tx('outer', 'b')).toBe('translate3d(-190px, 0, 0)');
      expect(tx('outer', 'c')).toBe('translate3d(calc(100% - 190px), 0, 0)');
      expect({ b: renders.get('outer:b'), c: renders.get('outer:c') }).toEqual(before); // DOM-only frames
      expect(tabOf('outer')).toBe('b');
    });

    it('reveals the previous page left of the active one while dragging right', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 300);
      touchTo(p, 380);
      expect(slideTabs('outer')).toEqual(['a', 'b']);
      expect(tx('outer', 'b')).toBe('translate3d(80px, 0, 0)');
      expect(tx('outer', 'a')).toBe('translate3d(calc(-100% + 80px), 0, 0)');
      expect(slide('outer', 'a')).toHaveAttribute('data-pager-peer', 'prev');
    });

    it('swaps the revealed neighbour when the finger crosses its start point', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 340);
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      touchTo(p, 470);
      expect(slideTabs('outer')).toEqual(['a', 'b']);
      expect(tx('outer', 'b')).toBe('translate3d(70px, 0, 0)');
      expect(tx('outer', 'a')).toBe('translate3d(calc(-100% + 70px), 0, 0)');
      touchTo(p, 300);
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      expect(tx('outer', 'c')).toBe('translate3d(calc(100% - 100px), 0, 0)');
    });

    it('follows a mouse pointer drag too (ignoring other pointers)', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      fireEvent.pointerDown(p, { pointerType: 'mouse', pointerId: 3, button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 3, clientX: 330, clientY: 302 });
      expect(tx('outer', 'b')).toBe('translate3d(-70px, 0, 0)');
      expect(tx('outer', 'c')).toBe('translate3d(calc(100% - 70px), 0, 0)');
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 4, clientX: 100, clientY: 302 });
      expect(tx('outer', 'b')).toBe('translate3d(-70px, 0, 0)');
    });

    it('never moves on vertical scrolls and is inert while disabled', () => {
      const { unmount } = render(<Strip id="outer" order={OUTER} initial="b" />);
      let p = activePage('outer');
      touchDown(p, 400, 300);
      touchTo(p, 395, 200);
      touchTo(p, 300, 100);
      touchUp(p, 300, 100);
      expectAtRest('outer', 'b');
      unmount();

      render(<Strip id="outer" order={OUTER} initial="b" enabled={false} />);
      p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 250);
      expectAtRest('outer', 'b');
    });
  });

  describe('release', () => {
    it('commits from the release position: the old page glides out, the peeked page glides in and stays the same instance', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 300);
      const peeked = slide('outer', 'c');
      const peekedPage = screen.getByTestId('page-outer:c');
      expect(mounts.get('outer:c')).toBe(1);
      touchTo(p, 250);
      touchUp(p, 250);
      expect(tabOf('outer')).toBe('c');
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      // c is now active (interactive); b is the outgoing page.
      expect(slide('outer', 'c')).not.toHaveAttribute('inert');
      expect(slide('outer', 'b')).toHaveAttribute('inert');
      expect(slide('outer', 'b')).toHaveAttribute('data-pager-peer', 'prev');
      expect(tx('outer', 'b')).toBe('translate3d(-100%, 0, 0)');
      expect(tx('outer', 'c')).toBe('translate3d(0px, 0, 0)');
      expect(slide('outer', 'c').style.transition).toContain('ms');
      advance(SETTLE_MS);
      expectAtRest('outer', 'c');
      expect(slide('outer', 'c')).toBe(peeked); // same DOM node…
      expect(screen.getByTestId('page-outer:c')).toBe(peekedPage);
      expect(mounts.get('outer:c')).toBe(1); // …and the same fiber: no remount
    });

    it('commits to the previous page symmetrically', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 200);
      touchTo(p, 300);
      touchTo(p, 350);
      touchUp(p, 350);
      expect(tabOf('outer')).toBe('a');
      expect(tx('outer', 'b')).toBe('translate3d(100%, 0, 0)');
      expect(tx('outer', 'a')).toBe('translate3d(0px, 0, 0)');
      fireEvent.transitionEnd(slide('outer', 'a'));
      expectAtRest('outer', 'a');
      expect(mounts.get('outer:a')).toBe(1);
    });

    it('starts the commit glide exactly where the finger left both pages', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 280);
      const seen: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const r of records) seen.push(`${(r.target as HTMLElement).dataset['pagerTab']}:${r.oldValue ?? ''}`);
      });
      observer.observe(pagerEl('outer'), { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
      touchUp(p, 280);
      for (const r of observer.takeRecords()) seen.push(`${(r.target as HTMLElement).dataset['pagerTab']}:${r.oldValue ?? ''}`);
      observer.disconnect();
      // Before the transition targets were written, both slides were still at the release offset.
      expect(seen.some((v) => v.startsWith('b:') && v.includes('translate3d(-120px, 0, 0)'))).toBe(true);
      expect(seen.some((v) => v.startsWith('c:') && v.includes('translate3d(calc(100% - 120px), 0, 0)'))).toBe(true);
      expect(seen.some((v) => v.includes('translate3d(0px, 0, 0)') && v.startsWith('b:'))).toBe(false); // never reset to 0 / flashed
    });

    it('scales the commit glide with the remaining travel', () => {
      expect(slideDurationMs(0, 400)).toBe(TAB_SLIDE_MS);
      expect(slideDurationMs(-200, 400)).toBe(TAB_SLIDE_MS / 2);
      expect(slideDurationMs(390, 400)).toBeGreaterThanOrEqual(120);
      expect(slideDurationMs(-120, 0)).toBe(TAB_SLIDE_MS); // no layout (jsdom)
    });

    it('glides both pages back below the threshold, then unmounts the neighbour and clears every inline style', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 370);
      expect(tx('outer', 'b')).toBe('translate3d(-30px, 0, 0)');
      touchUp(p, 370);
      expect(tabOf('outer')).toBe('b');
      expect(tx('outer', 'b')).toBe('translate3d(0px, 0, 0)');
      expect(tx('outer', 'c')).toBe('translate3d(100%, 0, 0)');
      expect(slide('outer', 'b').style.transition).toContain(`${SNAP_BACK_MS}ms`);
      expect(slide('outer', 'c').style.transition).toContain(`${SNAP_BACK_MS}ms`);
      advance(SNAP_BACK_MS + 100);
      expectAtRest('outer', 'b');
    });

    it('settles early on the active slide’s own transitionend only', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 300);
      touchTo(p, 330);
      touchUp(p, 330);
      fireEvent.transitionEnd(activePage('outer')); // a descendant's transition is ignored
      expect(slideTabs('outer')).toEqual(['a', 'b']);
      fireEvent.transitionEnd(slide('outer', 'b'));
      expectAtRest('outer', 'b');
    });

    it('glides back when a second finger joins (pinch) without switching tabs', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 300);
      fireEvent.touchMove(p, { touches: [{ clientX: 250, clientY: 300 }, { clientX: 500, clientY: 300 }] });
      expect(tx('outer', 'b')).toBe('translate3d(0px, 0, 0)');
      expect(tx('outer', 'c')).toBe('translate3d(100%, 0, 0)');
      touchUp(p, 200);
      expect(tabOf('outer')).toBe('b');
      advance(SNAP_BACK_MS + 100);
      expectAtRest('outer', 'b');
    });

    it('glides back on pointercancel, a mouse released outside and a lost touch release', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      fireEvent.pointerDown(p, { pointerType: 'mouse', pointerId: 9, button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 9, clientX: 300, clientY: 300 });
      fireEvent.pointerCancel(p, { pointerType: 'mouse', pointerId: 9 });
      expect(tx('outer', 'b')).toBe('translate3d(0px, 0, 0)');
      advance(SNAP_BACK_MS + 100);
      expectAtRest('outer', 'b');

      fireEvent.pointerDown(p, { pointerType: 'mouse', pointerId: 10, button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 10, clientX: 280, clientY: 300 });
      fireEvent.pointerUp(document.body, { pointerType: 'mouse', pointerId: 10, button: 0, clientX: 100, clientY: 300 });
      expect(tabOf('outer')).toBe('b');
      expect(tx('outer', 'b')).toBe('translate3d(0px, 0, 0)');
      advance(SNAP_BACK_MS + 100);

      touchDown(p, 400);
      touchTo(p, 300);
      fireEvent.touchEnd(window, { touches: [], changedTouches: [{ clientX: 300, clientY: 300 }] });
      expect(tx('outer', 'b')).toBe('translate3d(0px, 0, 0)');
      advance(SNAP_BACK_MS + 100);
      expectAtRest('outer', 'b');
    });
  });

  describe('outermost rubber band', () => {
    it('damps the single active page past the first / last tab without mounting a neighbour', () => {
      render(<Strip id="outer" order={OUTER} initial="a" />);
      const p = activePage('outer');
      touchDown(p, 300);
      touchTo(p, 350);
      expect(slideTabs('outer')).toEqual(['a']);
      expect(tx('outer', 'a')).toBe('translate3d(10px, 0, 0)');
      touchTo(p, 800);
      expect(tx('outer', 'a')).toBe('translate3d(36px, 0, 0)');
      expect(slideTabs('outer')).toEqual(['a']);
      touchTo(p, 200); // back the other way: a → b is possible, full dual-page tracking
      expect(slideTabs('outer')).toEqual(['a', 'b']);
      expect(tx('outer', 'a')).toBe('translate3d(-100px, 0, 0)');
      touchTo(p, 700);
      expect(slideTabs('outer')).toEqual(['a']);
      touchUp(p, 700);
      expect(tabOf('outer')).toBe('a');
      expect(tx('outer', 'a')).toBe('translate3d(0px, 0, 0)');
      expect(slide('outer', 'a').style.transition).toContain(`${SNAP_BACK_MS}ms`);
      advance(SNAP_BACK_MS + 100);
      expectAtRest('outer', 'a');
    });
  });

  describe('programmatic changes (tab bar taps)', () => {
    it('slides old and new page side by side, jumping several tabs without mounting the ones in between', () => {
      render(<Strip id="outer" order={OUTER} initial="a" />);
      const observer = new MutationObserver(() => {});
      observer.observe(pagerEl('outer'), { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
      fireEvent.click(screen.getByRole('tab', { name: 'outer-c' }));
      // Each slide's successive inline styles (old values of every style mutation).
      const seen = observer
        .takeRecords()
        .map((r) => `${(r.target as HTMLElement).dataset['pagerTab']}:${(r.oldValue ?? '').match(/transform: ([^;]+)/)?.[1] ?? ''}`);
      observer.disconnect();
      expect(tabOf('outer')).toBe('c');
      expect(slideTabs('outer')).toEqual(['a', 'c']); // never b
      expect(mounts.get('outer:b')).toBeUndefined();
      expect(seen).toContain('a:translate3d(0px, 0, 0)');
      expect(seen).toContain('c:translate3d(100%, 0, 0)');
      expect(tx('outer', 'a')).toBe('translate3d(-100%, 0, 0)');
      expect(tx('outer', 'c')).toBe('translate3d(0px, 0, 0)');
      expect(slide('outer', 'a')).toHaveAttribute('aria-hidden', 'true');
      advance(SETTLE_MS);
      expectAtRest('outer', 'c');

      fireEvent.click(screen.getByRole('tab', { name: 'outer-a' }));
      expect(slideTabs('outer')).toEqual(['a', 'c']);
      expect(tx('outer', 'c')).toBe('translate3d(100%, 0, 0)');
      expect(tx('outer', 'a')).toBe('translate3d(0px, 0, 0)');
      fireEvent.click(screen.getByRole('tab', { name: 'outer-a' })); // no change: keeps the running slide
      expect(slideTabs('outer')).toEqual(['a', 'c']);
      advance(SETTLE_MS);
      expectAtRest('outer', 'a');
    });

    it('retargets a tap mid-flight without orphan slides', () => {
      render(<Strip id="outer" order={OUTER} initial="a" />);
      fireEvent.click(screen.getByRole('tab', { name: 'outer-c' }));
      advance(TAB_SLIDE_MS / 2);
      fireEvent.click(screen.getByRole('tab', { name: 'outer-b' }));
      expect(tabOf('outer')).toBe('b');
      expect(slideTabs('outer')).toEqual(['b', 'c']); // a is gone
      expect(tx('outer', 'c')).toBe('translate3d(100%, 0, 0)');
      expect(tx('outer', 'b')).toBe('translate3d(0px, 0, 0)');
      advance(TAB_SLIDE_MS / 2 + 20); // the first slide's timer was cancelled
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      advance(SETTLE_MS);
      expectAtRest('outer', 'b');
    });

    it('a new drag catches a running slide and reuses the outgoing page as the neighbour', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      fireEvent.click(screen.getByRole('tab', { name: 'outer-c' }));
      const outgoing = slide('outer', 'b');
      const p = activePage('outer');
      touchDown(p, 300);
      touchTo(p, 350);
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      expect(slide('outer', 'b')).toBe(outgoing);
      expect(slide('outer', 'b')).toHaveAttribute('data-pager-peer', 'prev');
      expect(tx('outer', 'c')).toBe('translate3d(50px, 0, 0)');
      expect(tx('outer', 'b')).toBe('translate3d(calc(-100% + 50px), 0, 0)');
      expect(slide('outer', 'c').style.transition).toBe('none');
      advance(SETTLE_MS); // the cancelled slide's fallback never fires
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      touchTo(p, 330);
      touchUp(p, 330); // below the threshold: glide back
      advance(SNAP_BACK_MS + 100);
      expectAtRest('outer', 'c');
      expect(mounts.get('outer:b')).toBe(1);
    });
  });

  describe('nested strips', () => {
    function renderNested(outer: (typeof OUTER)[number] = 'b', inner: (typeof INNER)[number] = 'x') {
      return render(
        <Strip
          id="outer"
          order={OUTER}
          initial={outer}
          inner={(t) => (t === outer ? <Strip id="inner" order={INNER} initial={inner} /> : null)}
        />,
      );
    }

    it('drags the inner pages side by side and falls through to the outer pager at the inner edge', () => {
      renderNested('b', 'x');
      const p = activePage('inner');
      touchDown(p, 400);
      touchTo(p, 300); // left: inner x → y is possible
      expect(slideTabs('inner')).toEqual(['x', 'y']);
      expect(tx('inner', 'y')).toBe('translate3d(calc(100% - 100px), 0, 0)');
      expect(slideTabs('outer')).toEqual(['b']);
      expect(tx('outer', 'b')).toBe('');
      touchTo(p, 520); // reversed past the start: inner is at its first tab → outer moves
      expect(slideTabs('inner')).toEqual(['x']);
      expect(tx('inner', 'x')).toBe('');
      expect(slideTabs('outer')).toEqual(['a', 'b']);
      expect(tx('outer', 'b')).toBe('translate3d(120px, 0, 0)');
      expect(tx('outer', 'a')).toBe('translate3d(calc(-100% + 120px), 0, 0)');
      touchUp(p, 520);
      expect(tabOf('outer')).toBe('a');
      expect(tabOf('inner')).toBe('x'); // inner strip still mounted in the outgoing slide
      advance(SETTLE_MS);
      expectAtRest('outer', 'a');
    });

    it('commits only the inner strip while it can move', () => {
      renderNested('b', 'x');
      swipe(activePage('inner'), 400, 200);
      expect([tabOf('outer'), tabOf('inner')]).toEqual(['b', 'y']);
      expect(slideTabs('inner')).toEqual(['x', 'y']);
      expect(slideTabs('outer')).toEqual(['b']);
      advance(SETTLE_MS);
      expectAtRest('inner', 'y');
    });

    it('rubber-bands only the outermost strip when nobody can move', () => {
      renderNested('a', 'x');
      const p = activePage('inner');
      touchDown(p, 300);
      touchTo(p, 400);
      expect(slideTabs('inner')).toEqual(['x']);
      expect(tx('inner', 'x')).toBe('');
      expect(slideTabs('outer')).toEqual(['a']);
      expect(tx('outer', 'a')).toBe('translate3d(20px, 0, 0)');
      touchTo(p, 900);
      expect(tx('outer', 'a')).toBe('translate3d(36px, 0, 0)');
      touchUp(p, 900);
      expect([tabOf('outer'), tabOf('inner')]).toEqual(['a', 'x']);
      expect(tx('outer', 'a')).toBe('translate3d(0px, 0, 0)');
    });
  });

  describe('rest state, reduced motion and disabling', () => {
    it('under prefers-reduced-motion drags still follow, but releases and taps settle at once', () => {
      stubReducedMotion(true);
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 370);
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      touchUp(p, 370);
      expectAtRest('outer', 'b');

      mounts.clear();
      touchDown(p, 400);
      touchTo(p, 300);
      touchUp(p, 250);
      expect(tabOf('outer')).toBe('c');
      expectAtRest('outer', 'c');
      expect(mounts.get('outer:c')).toBe(1);

      // A real tap starts with a touchstart, which lifts the post-swipe click guard.
      const tabA = screen.getByRole('tab', { name: 'outer-a' });
      touchDown(tabA, 100, 20);
      touchUp(tabA, 100, 20);
      fireEvent.click(tabA);
      expectAtRest('outer', 'a');
    });

    it('disabling mid-drag or mid-slide drops the second page and every inline style at once', () => {
      const { rerender } = render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 300);
      expect(slideTabs('outer')).toEqual(['b', 'c']);
      rerender(<Strip id="outer" order={OUTER} initial="b" enabled={false} />);
      expectAtRest('outer', 'b');
      touchTo(p, 250);
      touchUp(p, 200);
      expectAtRest('outer', 'b');

      rerender(<Strip id="outer" order={OUTER} initial="b" />);
      fireEvent.click(screen.getByRole('tab', { name: 'outer-a' }));
      expect(slideTabs('outer')).toEqual(['a', 'b']);
      rerender(<Strip id="outer" order={OUTER} initial="b" enabled={false} />);
      expectAtRest('outer', 'a');
      fireEvent.click(screen.getByRole('tab', { name: 'outer-c' })); // disabled: instant swap
      expectAtRest('outer', 'c');
      advance(SETTLE_MS);
      expectAtRest('outer', 'c');
    });
  });

  describe('inactive slide isolation', () => {
    it('marks peeked / outgoing slides inert + aria-hidden and keeps their back interceptors unregistered', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 300);
      const peek = slide('outer', 'c');
      expect(peek).toHaveAttribute('aria-hidden', 'true');
      expect(peek).toHaveAttribute('inert');
      expect(inactiveSeen.get('outer:c')).toBe(true);
      expect(inactiveSeen.get('outer:b')).toBe(false);
      // ARIA queries only see the active page.
      expect(screen.getAllByText(/^outer:/).length).toBe(2);
      expect(within(pagerEl('outer')).queryByRole('button')).toBeNull();
      act(() => {
        expect(dispatchBackNavigation()).toBe(true);
      });
      expect(backLog).toEqual(['outer:b']); // never the peeked page

      touchTo(p, 250);
      touchUp(p, 250);
      expect(inactiveSeen.get('outer:c')).toBe(false);
      expect(inactiveSeen.get('outer:b')).toBe(true);
      backLog.length = 0;
      act(() => {
        dispatchBackNavigation();
      });
      expect(backLog).toEqual(['outer:c']); // the new page took over; the outgoing one is silent
    });

    it('a strip nested in a peeked slide is a still picture', () => {
      render(
        <Strip
          id="outer"
          order={OUTER}
          initial="a"
          inner={(t) => (t === 'b' ? <Strip id="inner" order={INNER} initial="y" /> : null)}
        />,
      );
      const p = activePage('outer');
      touchDown(p, 400);
      touchTo(p, 300);
      expect(slideTabs('inner')).toEqual(['y']);
      expect(inactiveSeen.get('inner:y')).toBe(true); // inherits the outer slide's inactivity
    });
  });
});

describe('<Tabs> indicator', () => {
  afterEach(cleanup);

  it('slides the active indicator over from the previous tab (FLIP) and leaves no inline style', () => {
    function Harness() {
      const [tab, setTab] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs
          label="t"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C' },
          ]}
        />
      );
    }
    render(<Harness />);
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    tabs.forEach((el, i) => {
      Object.defineProperty(el, 'offsetLeft', { configurable: true, value: i * 100 });
      Object.defineProperty(el, 'offsetWidth', { configurable: true, value: i === 2 ? 132 : 100 });
    });
    const indicator = tabs[2]!.querySelector<HTMLElement>('.k-tabs__indicator')!;
    const observer = new MutationObserver(() => {});
    observer.observe(indicator, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    fireEvent.click(tabs[2]!);
    const seen = observer.takeRecords().map((r) => r.oldValue ?? '');
    observer.disconnect();
    // a: centre 50, inner width 68; c: centre 266, inner width 100 → shift −216, scale 0.68.
    expect(seen.some((v) => v.includes('translateX(-216px) scaleX(0.68)'))).toBe(true);
    expect(indicator.style.transform).toBe('');
    expect(indicator.style.transition).toBe('');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
  });
});
