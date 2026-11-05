import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStores } from '../../test/utils';
import { Dialog } from './Dialog';
import { BottomSheet } from './Sheet';
import { useTabSwipe } from './Tabs';
import { installPointerEventPolyfill } from '../../test/pointer';

type Outer = 'a' | 'b' | 'c';
type Inner = 'x' | 'y' | 'z';
const OUTER: readonly Outer[] = ['a', 'b', 'c'];
const INNER: readonly Inner[] = ['x', 'y', 'z'];

function InnerStrip({ onCardClick, children }: { onCardClick: () => void; children?: ReactNode }) {
  const [tab, setTab] = useState<Inner>('x');
  const swipe = useTabSwipe<Inner>(INNER, tab, setTab);
  return (
    <div data-testid="inner" data-tab={tab} {...swipe}>
      <button type="button" data-testid="inner-card" onClick={onCardClick}>
        card
      </button>
      {children}
    </div>
  );
}

function Harness({
  onCardClick = () => {},
  enabled = true,
  withInner = false,
  dialogOpen = false,
  sheetOpen = false,
}: {
  onCardClick?: () => void;
  enabled?: boolean;
  withInner?: boolean;
  dialogOpen?: boolean;
  sheetOpen?: boolean;
}) {
  const [tab, setTab] = useState<Outer>('b');
  const [log, setLog] = useState<string[]>([]);
  const swipe = useTabSwipe<Outer>(
    OUTER,
    tab,
    (next, direction) => {
      setTab(next);
      setLog((l) => [...l, `${next}:${direction}`]);
    },
    { enabled },
  );
  return (
    <div data-testid="outer" data-tab={tab} data-log={log.join(',')} {...swipe}>
      <button type="button" data-testid="card" onClick={onCardClick}>
        cover card
      </button>
      <input data-testid="field" defaultValue="" />
      <div role="slider" aria-valuenow={0} data-testid="slider" />
      <div data-no-tab-swipe data-testid="opt-out">
        <span data-testid="opt-out-child">no swipe</span>
      </div>
      <div contentEditable="true" suppressContentEditableWarning data-testid="editable">
        editable
      </div>
      <div data-testid="scroller" style={{ overflowX: 'auto' }}>
        <span data-testid="scroller-chip">chip</span>
      </div>
      {withInner && <InnerStrip onCardClick={onCardClick} />}
      <Dialog open={dialogOpen} onClose={() => {}} title="Portaled">
        <p data-testid="dialog-body">dialog body</p>
      </Dialog>
      <BottomSheet open={sheetOpen} onClose={() => {}} title="Sheet">
        <p data-testid="sheet-body">sheet body</p>
      </BottomSheet>
    </div>
  );
}

function touchSwipe(el: Element, fromX: number, toX: number, y = 300): void {
  fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchMove(el, { touches: [{ clientX: (fromX + toX) / 2, clientY: y + 2 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: toX, clientY: y + 3 }] });
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: toX, clientY: y + 3 }] });
}

function mouseSwipe(el: Element, fromX: number, toX: number, y = 300): void {
  fireEvent.pointerDown(el, { pointerType: 'mouse', pointerId: 7, button: 0, clientX: fromX, clientY: y });
  fireEvent.pointerMove(el, { pointerType: 'mouse', pointerId: 7, clientX: (fromX + toX) / 2, clientY: y + 2 });
  fireEvent.pointerUp(el, { pointerType: 'mouse', pointerId: 7, button: 0, clientX: toX, clientY: y + 3 });
}

const outerTab = (): string | undefined => screen.getByTestId('outer').dataset['tab'];
const innerTab = (): string | undefined => screen.getByTestId('inner').dataset['tab'];

function mockHorizontalScroller(el: HTMLElement, scrollLeft: number): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 600 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 200 });
  el.scrollLeft = scrollLeft;
  Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: scrollLeft });
}

describe('useTabSwipe', () => {
  let uninstallPointerEvent: () => void = () => {};
  beforeAll(() => {
    uninstallPointerEvent = installPointerEventPolyfill();
  });
  afterAll(() => uninstallPointerEvent());
  beforeEach(resetStores);
  afterEach(cleanup);

  it('swipes left to the next tab and right to the previous one (touch), reporting the direction', () => {
    render(<Harness />);
    const outer = screen.getByTestId('outer');
    touchSwipe(outer, 400, 200);
    expect(outerTab()).toBe('c');
    touchSwipe(outer, 400, 200);
    expect(outerTab()).toBe('c'); // clamped at the last tab
    touchSwipe(outer, 200, 400);
    touchSwipe(outer, 200, 400);
    expect(outerTab()).toBe('a');
    touchSwipe(outer, 200, 400);
    expect(outerTab()).toBe('a'); // clamped at the first tab
    expect(outer.dataset['log']).toBe('c:next,b:prev,a:prev');
  });

  it('swipes with a mouse / pen pointer too, and ignores short or vertical drags', () => {
    render(<Harness />);
    const outer = screen.getByTestId('outer');
    mouseSwipe(outer, 400, 200);
    expect(outerTab()).toBe('c');
    mouseSwipe(outer, 200, 220); // too short
    fireEvent.pointerDown(outer, { pointerType: 'mouse', pointerId: 8, button: 0, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(outer, { pointerType: 'mouse', pointerId: 8, clientX: 290, clientY: 300 });
    fireEvent.pointerUp(outer, { pointerType: 'mouse', pointerId: 8, button: 0, clientX: 250, clientY: 400 });
    expect(outerTab()).toBe('c');
    mouseSwipe(outer, 200, 400);
    expect(outerTab()).toBe('b');
  });

  it('is inert when disabled', () => {
    render(<Harness enabled={false} />);
    touchSwipe(screen.getByTestId('outer'), 400, 200);
    mouseSwipe(screen.getByTestId('outer'), 400, 200);
    expect(outerTab()).toBe('b');
  });

  it.each([['field'], ['slider'], ['opt-out-child'], ['editable']])('ignores swipes starting on %s', (testId) => {
    render(<Harness />);
    touchSwipe(screen.getByTestId(testId), 400, 200);
    expect(outerTab()).toBe('b');
  });

  it('ignores swipes starting inside the outer 24px viewport edges (Android edge-back)', () => {
    render(<Harness />);
    const outer = screen.getByTestId('outer');
    touchSwipe(outer, 12, 300);
    touchSwipe(outer, window.innerWidth - 10, window.innerWidth - 300);
    expect(outerTab()).toBe('b');
  });

  it('ignores multi-touch (pinch) gestures', () => {
    render(<Harness />);
    const outer = screen.getByTestId('outer');
    fireEvent.touchStart(outer, { touches: [{ clientX: 400, clientY: 300 }, { clientX: 500, clientY: 300 }] });
    fireEvent.touchEnd(outer, { touches: [], changedTouches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchStart(outer, { touches: [{ clientX: 400, clientY: 300 }] });
    fireEvent.touchMove(outer, { touches: [{ clientX: 300, clientY: 300 }, { clientX: 500, clientY: 300 }] });
    fireEvent.touchEnd(outer, { touches: [], changedTouches: [{ clientX: 200, clientY: 300 }] });
    expect(outerTab()).toBe('b');
  });

  it('ignores events bubbling (via React) out of a portaled Dialog', () => {
    render(<Harness dialogOpen />);
    const body = screen.getByTestId('dialog-body');
    expect(screen.getByTestId('outer').contains(body)).toBe(false); // portaled to document.body
    touchSwipe(body, 400, 200);
    mouseSwipe(screen.getByRole('dialog'), 400, 200);
    expect(outerTab()).toBe('b');
  });

  it('ignores swipes on a BottomSheet nested inside the swipe container', () => {
    render(<Harness sheetOpen />);
    touchSwipe(screen.getByTestId('sheet-body'), 400, 200);
    expect(outerTab()).toBe('b');
  });

  it('lets a horizontal scroll container scroll until its edge, then chains to the tab swipe', () => {
    render(<Harness />);
    const scroller = screen.getByTestId('scroller');
    mockHorizontalScroller(scroller, 0);
    // Content can still scroll towards the right end (swipe left): the bar owns it.
    touchSwipe(screen.getByTestId('scroller-chip'), 400, 200);
    expect(outerTab()).toBe('b');
    // At scrollLeft 0 the bar cannot scroll further left (swipe right): tabs switch.
    touchSwipe(screen.getByTestId('scroller-chip'), 200, 400);
    expect(outerTab()).toBe('a');
  });

  it('suppresses the click that trails a committed horizontal swipe across a card, but not later taps', () => {
    const onCardClick = vi.fn();
    render(<Harness onCardClick={onCardClick} />);
    const card = screen.getByTestId('card');
    mouseSwipe(card, 400, 200);
    expect(outerTab()).toBe('c');
    fireEvent.click(card);
    expect(onCardClick).not.toHaveBeenCalled();
    // One-shot: the next genuine tap goes through.
    fireEvent.click(card);
    expect(onCardClick).toHaveBeenCalledTimes(1);
  });

  it('suppresses the trailing click even when a swipe hits the last tab (no tab change)', () => {
    const onCardClick = vi.fn();
    render(<Harness onCardClick={onCardClick} />);
    const card = screen.getByTestId('card');
    touchSwipe(card, 400, 200); // b -> c
    fireEvent.click(card);
    touchSwipe(card, 400, 200); // c: clamped, still a drag
    fireEvent.click(card);
    expect(onCardClick).not.toHaveBeenCalled();
    // A new gesture start clears a still-pending guard: a plain tap clicks.
    touchSwipe(card, 400, 200);
    fireEvent.touchStart(card, { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.touchEnd(card, { touches: [], changedTouches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.click(card);
    expect(onCardClick).toHaveBeenCalledTimes(1);
  });

  it('expires the click guard after a short window', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const onCardClick = vi.fn();
      render(<Harness onCardClick={onCardClick} />);
      const card = screen.getByTestId('card');
      mouseSwipe(card, 400, 200);
      vi.setSystemTime(Date.now() + 1000);
      fireEvent.click(card);
      expect(onCardClick).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('nested strips (ViewPager2-style chaining)', () => {
    it('inner strip claims swipes it can perform; at its edges the outer strip moves — never both', () => {
      render(<Harness withInner />);
      const inner = screen.getByTestId('inner');
      expect([outerTab(), innerTab()]).toEqual(['b', 'x']);

      // x is the inner's first tab: swiping right falls through to the outer strip.
      touchSwipe(inner, 200, 400);
      expect([outerTab(), innerTab()]).toEqual(['a', 'x']);
      touchSwipe(inner, 400, 200); // inner can advance: inner only
      expect([outerTab(), innerTab()]).toEqual(['a', 'y']);
      touchSwipe(inner, 400, 200);
      expect([outerTab(), innerTab()]).toEqual(['a', 'z']);
      // z is the inner's last tab: swiping left falls through to the outer strip.
      touchSwipe(inner, 400, 200);
      expect([outerTab(), innerTab()]).toEqual(['b', 'z']);
      touchSwipe(inner, 200, 400); // inner can go back: inner only
      expect([outerTab(), innerTab()]).toEqual(['b', 'y']);
    });

    it('chains with mouse pointers as well', () => {
      render(<Harness withInner />);
      const inner = screen.getByTestId('inner');
      mouseSwipe(inner, 400, 200);
      expect([outerTab(), innerTab()]).toEqual(['b', 'y']);
      mouseSwipe(inner, 400, 200);
      mouseSwipe(inner, 400, 200);
      expect([outerTab(), innerTab()]).toEqual(['c', 'z']);
    });

    it('honours a horizontally locked touchcancel (Android WebView) exactly once across levels', () => {
      render(<Harness withInner />);
      const inner = screen.getByTestId('inner');
      act(() => {
        fireEvent.touchStart(inner, { touches: [{ clientX: 400, clientY: 300 }] });
        fireEvent.touchMove(inner, { touches: [{ clientX: 200, clientY: 302 }] });
        fireEvent.touchCancel(inner);
      });
      expect([outerTab(), innerTab()]).toEqual(['b', 'y']);
    });

    it('suppresses the trailing click on a card inside the inner strip', () => {
      const onCardClick = vi.fn();
      render(<Harness withInner onCardClick={onCardClick} />);
      const card = screen.getByTestId('inner-card');
      mouseSwipe(card, 400, 200);
      expect([outerTab(), innerTab()]).toEqual(['b', 'y']);
      fireEvent.click(card);
      expect(onCardClick).not.toHaveBeenCalled();
      fireEvent.click(card);
      expect(onCardClick).toHaveBeenCalledTimes(1);
    });
  });
});
