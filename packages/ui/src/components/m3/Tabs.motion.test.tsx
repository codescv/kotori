/**
 * Finger-following drag, nested drag coordination, outermost rubber band, snap-back
 * and directional slide-in of `useTabSwipe({ paneRef })` and the `<Tabs>` indicator.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPointerEventPolyfill } from '../../test/pointer';
import { resetStores } from '../../test/utils';
import { Tabs, useTabSwipe } from './Tabs';
import { SNAP_BACK_MS, TAB_SLIDE_MS } from './tabMotion';

const OUTER = ['a', 'b', 'c'] as const;
const INNER = ['x', 'y', 'z'] as const;

function Strip<T extends string>({
  id,
  order,
  initial,
  enabled = true,
  onRender,
  children,
}: {
  id: string;
  order: readonly T[];
  initial: T;
  enabled?: boolean;
  onRender?: () => void;
  children?: ReactNode;
}) {
  const [tab, setTab] = useState<T>(initial);
  const paneRef = useRef<HTMLDivElement>(null);
  const swipe = useTabSwipe<T>(order, tab, (next) => setTab(next), { paneRef, enabled });
  onRender?.();
  return (
    <div data-testid={id} data-tab={tab} {...swipe}>
      <Tabs<T> label={id} value={tab} onChange={setTab} tabs={order.map((v) => ({ value: v, label: `${id}-${v}` }))} />
      <div ref={paneRef} data-testid={`${id}-pane`}>
        <span>{`${id}:${tab}`}</span>
        {children}
      </div>
    </div>
  );
}

const pane = (id: string): HTMLElement => screen.getByTestId(`${id}-pane`);
const tabOf = (id: string): string | undefined => screen.getByTestId(id).dataset['tab'];
const tx = (id: string): string => pane(id).style.transform;

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

describe('useTabSwipe pane motion', () => {
  let uninstallPointerEvent: () => void = () => {};
  beforeAll(() => {
    uninstallPointerEvent = installPointerEventPolyfill();
  });
  afterAll(() => uninstallPointerEvent());
  beforeEach(() => {
    resetStores();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('finger-following drag', () => {
    it('translates the pane with the touch delta via the DOM only (no re-render per move)', () => {
      const renders = vi.fn();
      render(<Strip id="outer" order={OUTER} initial="b" onRender={renders} />);
      const before = renders.mock.calls.length;
      const p = pane('outer');
      touchDown(p, 400);
      touchTo(p, 395); // within the touch slop: not locked yet
      expect(tx('outer')).toBe('');
      touchTo(p, 340);
      expect(tx('outer')).toBe('translate3d(-60px, 0, 0)');
      expect(p.style.willChange).toBe('transform');
      touchTo(p, 250);
      expect(tx('outer')).toBe('translate3d(-150px, 0, 0)');
      touchTo(p, 520);
      expect(tx('outer')).toBe('translate3d(120px, 0, 0)');
      expect(renders.mock.calls.length).toBe(before);
      expect(tabOf('outer')).toBe('b');
    });

    it('follows a mouse pointer drag too', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      fireEvent.pointerDown(p, { pointerType: 'mouse', pointerId: 3, button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 3, clientX: 330, clientY: 302 });
      expect(tx('outer')).toBe('translate3d(-70px, 0, 0)');
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 4, clientX: 100, clientY: 302 }); // other pointer
      expect(tx('outer')).toBe('translate3d(-70px, 0, 0)');
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 3, clientX: 280, clientY: 304 });
      expect(tx('outer')).toBe('translate3d(-120px, 0, 0)');
    });

    it('never translates on vertical scrolls', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      touchDown(p, 400, 300);
      touchTo(p, 395, 200);
      touchTo(p, 300, 100);
      expect(tx('outer')).toBe('');
      touchUp(p, 300, 100);
      expect(tabOf('outer')).toBe('b');
    });

    it('is inert while disabled', () => {
      render(<Strip id="outer" order={OUTER} initial="b" enabled={false} />);
      const p = pane('outer');
      touchDown(p, 400);
      touchTo(p, 250);
      expect(tx('outer')).toBe('');
    });
  });

  describe('nested strips', () => {
    function renderNested(outer: (typeof OUTER)[number] = 'b', inner: (typeof INNER)[number] = 'x') {
      return render(
        <Strip id="outer" order={OUTER} initial={outer}>
          <Strip id="inner" order={INNER} initial={inner} />
        </Strip>,
      );
    }

    it('translates only the innermost pane that can move, falling through to the outer one at the inner edge', () => {
      renderNested('b', 'x');
      const p = pane('inner');
      touchDown(p, 400);
      touchTo(p, 300); // left: inner x → y is possible
      expect(tx('inner')).toBe('translate3d(-100px, 0, 0)');
      expect(tx('outer')).toBe('');
      touchTo(p, 520); // reversed past the start: inner is at its first tab → outer moves
      expect(tx('inner')).toBe('');
      expect(tx('outer')).toBe('translate3d(120px, 0, 0)');
      touchUp(p, 520);
      expect([tabOf('outer'), tabOf('inner')]).toEqual(['a', 'x']);
    });

    it('chains the same way for mouse drags', () => {
      renderNested('b', 'z');
      const p = pane('inner');
      fireEvent.pointerDown(p, { pointerType: 'mouse', pointerId: 5, button: 0, clientX: 500, clientY: 300 });
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 5, clientX: 380, clientY: 300 });
      // z is the inner's last tab: dragging left moves the outer pane.
      expect(tx('inner')).toBe('');
      expect(tx('outer')).toBe('translate3d(-120px, 0, 0)');
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 5, clientX: 600, clientY: 300 });
      expect(tx('inner')).toBe('translate3d(100px, 0, 0)');
      expect(tx('outer')).toBe('');
    });

    it('rubber-bands only the outermost strip when nobody can move', () => {
      renderNested('a', 'x');
      const p = pane('inner');
      touchDown(p, 300);
      touchTo(p, 400); // +100 → 100 * 0.2
      expect(tx('inner')).toBe('');
      expect(tx('outer')).toBe('translate3d(20px, 0, 0)');
      touchTo(p, 900); // clamped
      expect(tx('outer')).toBe('translate3d(36px, 0, 0)');
      touchUp(p, 900);
      expect([tabOf('outer'), tabOf('inner')]).toEqual(['a', 'x']);
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)'); // gliding back
    });
  });

  describe('rubber band and snap-back', () => {
    it('damps drags past the first / last tab (dx * 0.2, max 36px)', () => {
      render(<Strip id="outer" order={OUTER} initial="a" />);
      const p = pane('outer');
      touchDown(p, 300);
      touchTo(p, 350);
      expect(tx('outer')).toBe('translate3d(10px, 0, 0)');
      touchTo(p, 800);
      expect(tx('outer')).toBe('translate3d(36px, 0, 0)');
      touchTo(p, 200); // back the other way: a → b is possible, full finger tracking
      expect(tx('outer')).toBe('translate3d(-100px, 0, 0)');
    });

    it('glides back to rest when released below the threshold, then clears every inline style', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      touchDown(p, 400);
      touchTo(p, 370);
      expect(tx('outer')).toBe('translate3d(-30px, 0, 0)');
      touchUp(p, 370);
      expect(tabOf('outer')).toBe('b');
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)');
      expect(p.style.transition).toContain(`${SNAP_BACK_MS}ms`);
      act(() => {
        vi.advanceTimersByTime(SNAP_BACK_MS + 100);
      });
      expect(p.getAttribute('style') ?? '').toBe('');
    });

    it('settles early on transitionend', () => {
      render(<Strip id="outer" order={OUTER} initial="a" />);
      const p = pane('outer');
      touchDown(p, 300);
      touchTo(p, 450);
      touchUp(p, 450);
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)');
      fireEvent.transitionEnd(p.firstElementChild!); // a descendant's transition is ignored
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)');
      fireEvent.transitionEnd(p);
      expect(p.getAttribute('style') ?? '').toBe('');
    });

    it('glides back when a second finger joins (pinch) without switching tabs', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      touchDown(p, 400);
      touchTo(p, 300);
      expect(tx('outer')).toBe('translate3d(-100px, 0, 0)');
      fireEvent.touchMove(p, { touches: [{ clientX: 250, clientY: 300 }, { clientX: 500, clientY: 300 }] });
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)');
      touchUp(p, 200);
      expect(tabOf('outer')).toBe('b');
      act(() => {
        vi.advanceTimersByTime(SNAP_BACK_MS + 100);
      });
      expect(tx('outer')).toBe('');
    });

    it('glides back on pointercancel and on a mouse released outside the container', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      fireEvent.pointerDown(p, { pointerType: 'mouse', pointerId: 9, button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 9, clientX: 300, clientY: 300 });
      fireEvent.pointerCancel(p, { pointerType: 'mouse', pointerId: 9 });
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)');
      act(() => {
        vi.advanceTimersByTime(SNAP_BACK_MS + 100);
      });
      expect(tx('outer')).toBe('');

      fireEvent.pointerDown(p, { pointerType: 'mouse', pointerId: 10, button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(p, { pointerType: 'mouse', pointerId: 10, clientX: 280, clientY: 300 });
      expect(tx('outer')).toBe('translate3d(-120px, 0, 0)');
      fireEvent.pointerUp(document.body, { pointerType: 'mouse', pointerId: 10, button: 0, clientX: 100, clientY: 300 });
      expect(tabOf('outer')).toBe('b');
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)');
    });

    it('never gets stuck when the release never reaches React (touched node removed)', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      touchDown(p, 400);
      touchTo(p, 300);
      fireEvent.touchEnd(window, { touches: [], changedTouches: [{ clientX: 300, clientY: 300 }] });
      expect(tx('outer')).toBe('translate3d(0px, 0, 0)');
    });

    it('clears instantly under prefers-reduced-motion', () => {
      stubReducedMotion(true);
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      touchDown(p, 400);
      touchTo(p, 370);
      expect(tx('outer')).toBe('translate3d(-30px, 0, 0)');
      touchUp(p, 370);
      expect(p.getAttribute('style') ?? '').toBe('');
    });
  });

  describe('directional slide-in', () => {
    it('slides in from the right on next / from the left on prev, switching tabs synchronously', () => {
      render(<Strip id="outer" order={OUTER} initial="b" />);
      const p = pane('outer');
      swipe(p, 400, 200);
      expect(tabOf('outer')).toBe('c');
      expect(p).toHaveAttribute('data-tab-slide', 'next');
      expect(tx('outer')).toBe(''); // the drag offset hands over to the keyframes
      expect(p.style.willChange).toBe('');
      swipe(p, 200, 400);
      expect(tabOf('outer')).toBe('b');
      expect(p).toHaveAttribute('data-tab-slide', 'prev');
      act(() => {
        vi.advanceTimersByTime(TAB_SLIDE_MS + 100);
      });
      expect(p).not.toHaveAttribute('data-tab-slide');
      expect(p.getAttribute('style') ?? '').toBe('');
    });

    it('restarts on consecutive changes in the same direction', () => {
      render(<Strip id="outer" order={['a', 'b', 'c', 'd']} initial="a" />);
      const p = pane('outer');
      const reflows = vi.spyOn(p, 'offsetWidth', 'get');
      swipe(p, 400, 200);
      act(() => {
        vi.advanceTimersByTime(TAB_SLIDE_MS - 60);
      });
      swipe(p, 400, 200);
      expect(tabOf('outer')).toBe('c');
      expect(p).toHaveAttribute('data-tab-slide', 'next');
      expect(reflows).toHaveBeenCalledTimes(2); // forced restart each time
      act(() => {
        vi.advanceTimersByTime(TAB_SLIDE_MS - 60);
      });
      expect(p).toHaveAttribute('data-tab-slide', 'next'); // timer restarted with the animation
      fireEvent.animationEnd(p);
      expect(p).not.toHaveAttribute('data-tab-slide');
    });

    it('slides on tab bar taps in the direction of the destination', () => {
      render(<Strip id="outer" order={OUTER} initial="a" />);
      const p = pane('outer');
      fireEvent.click(screen.getByRole('tab', { name: 'outer-c' }));
      expect(tabOf('outer')).toBe('c');
      expect(p).toHaveAttribute('data-tab-slide', 'next');
      fireEvent.click(screen.getByRole('tab', { name: 'outer-b' }));
      expect(p).toHaveAttribute('data-tab-slide', 'prev');
      fireEvent.click(screen.getByRole('tab', { name: 'outer-b' })); // no change: keeps the running slide
      expect(p).toHaveAttribute('data-tab-slide', 'prev');
    });

    it('a drag interrupts a running slide-in', () => {
      render(<Strip id="outer" order={OUTER} initial="a" />);
      const p = pane('outer');
      fireEvent.click(screen.getByRole('tab', { name: 'outer-b' }));
      expect(p).toHaveAttribute('data-tab-slide', 'next');
      touchDown(p, 400);
      touchTo(p, 330);
      expect(p).not.toHaveAttribute('data-tab-slide');
      expect(tx('outer')).toBe('translate3d(-70px, 0, 0)');
    });

    it('only the strip whose tab changed slides (nested)', () => {
      render(
        <Strip id="outer" order={OUTER} initial="b">
          <Strip id="inner" order={INNER} initial="x" />
        </Strip>,
      );
      swipe(pane('inner'), 400, 200);
      expect(pane('inner')).toHaveAttribute('data-tab-slide', 'next');
      expect(pane('outer')).not.toHaveAttribute('data-tab-slide');
      swipe(pane('inner'), 200, 400);
      swipe(pane('inner'), 200, 400); // inner at x → outer b → a
      expect(tabOf('outer')).toBe('a');
      expect(pane('outer')).toHaveAttribute('data-tab-slide', 'prev');
      expect(tx('inner')).toBe('');
    });

    it('does not slide under prefers-reduced-motion or while disabled, and disabling clears motion', () => {
      stubReducedMotion(true);
      const { rerender } = render(<Strip id="outer" order={OUTER} initial="a" />);
      fireEvent.click(screen.getByRole('tab', { name: 'outer-b' }));
      expect(pane('outer')).not.toHaveAttribute('data-tab-slide');
      vi.unstubAllGlobals();

      fireEvent.click(screen.getByRole('tab', { name: 'outer-c' }));
      expect(pane('outer')).toHaveAttribute('data-tab-slide', 'next');
      rerender(<Strip id="outer" order={OUTER} initial="a" enabled={false} />);
      expect(pane('outer')).not.toHaveAttribute('data-tab-slide');
      fireEvent.click(screen.getByRole('tab', { name: 'outer-a' }));
      expect(pane('outer')).not.toHaveAttribute('data-tab-slide');
      expect(pane('outer').getAttribute('style') ?? '').toBe('');
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
