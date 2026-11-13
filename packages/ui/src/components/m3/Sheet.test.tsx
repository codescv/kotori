import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './Sheet';

afterEach(cleanup);

// jsdom lacks PointerEvent, so `fireEvent.pointer*` would drop `clientY`.
const hadPointerEvent = typeof window.PointerEvent === 'function';
beforeAll(() => {
  if (hadPointerEvent) return;
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal('PointerEvent', PointerEventPolyfill);
});
afterAll(() => {
  if (!hadPointerEvent) vi.unstubAllGlobals();
});

/** jsdom has no layout; pin the body's scroll geometry (mutable via the returned setter). */
function mockBodySize(body: HTMLElement, scrollHeight: number, clientHeight: number) {
  const size = { scrollHeight, clientHeight };
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => size.clientHeight });
  return (next: { scrollHeight?: number; clientHeight?: number }) => Object.assign(size, next);
}

describe('BottomSheet snap points', () => {
  it('opens in the peek snap and toggles to expanded by tapping or keyboard on the handle', () => {
    render(
      <BottomSheet open onClose={() => {}} title="AI 解析">
        <p>body</p>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const handle = screen.getByTestId('bottom-sheet-handle');
    expect(sheet).toHaveClass('is-peek');
    expect(sheet.dataset['snap']).toBe('peek');
    expect(handle).toHaveAttribute('aria-expanded', 'false');

    // A tap (pointer down/up without movement) expands.
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 401, pointerId: 1 });
    expect(sheet).toHaveClass('is-expanded');
    expect(handle).toHaveAttribute('aria-expanded', 'true');

    // Keyboard toggles back to peek.
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(sheet).toHaveClass('is-peek');
  });

  it('drag up expands, and dragging down on the handle dismisses directly even from expanded', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="AI 解析">
        <p>body</p>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const handle = screen.getByTestId('bottom-sheet-handle');

    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 420, pointerId: 1 });
    expect(sheet).toHaveClass('is-expanded');

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 180, pointerId: 1 });
    expect(sheet.style.transform).toBe('translateY(80px)');
    fireEvent.pointerUp(handle, { clientY: 180, pointerId: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honours initialSnap="expanded"', () => {
    render(
      <BottomSheet open onClose={() => {}} title="t" initialSnap="expanded">
        <p>body</p>
      </BottomSheet>,
    );
    expect(screen.getByRole('dialog')).toHaveClass('is-expanded');
  });

  it('pulls down to dismiss from .k-sheet__body when at scrollTop === 0 and suppresses accidental child click', () => {
    const onClose = vi.fn();
    const onChildClick = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="AI 解析">
        <button type="button" onClick={onChildClick}>
          词汇按钮
        </button>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    const btn = screen.getByRole('button', { name: '词汇按钮' });
    body.scrollTop = 0;

    fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(body, { touches: [{ clientX: 202, clientY: 390 }] });
    expect(sheet.style.transform).toBe('translateY(90px)');
    fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 202, clientY: 390 }] });

    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(btn);
    expect(onChildClick).not.toHaveBeenCalled();
  });

  it('scrolls up from scrollTop > 0 to 0 and seamlessly transitions into pull-to-dismiss in the same gesture, without dismissing while scrollTop > 0', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="AI 解析">
        <div style={{ height: 1200 }}>long breakdown</div>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    // jsdom has no layout: give the body real overflow (1200px content in a 400px body).
    mockBodySize(body, 1200, 400);

    // 1. Scrolling while scrollTop stays > 0 never translates or dismisses the sheet.
    body.scrollTop = 160;
    fireEvent.touchStart(body, { touches: [{ clientX: 180, clientY: 260 }] });
    body.scrollTop = 60;
    fireEvent.touchMove(body, { touches: [{ clientX: 180, clientY: 360 }] });
    expect(sheet.style.transform).toBe('');
    fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 180, clientY: 360 }] });
    expect(onClose).not.toHaveBeenCalled();

    // 2. Scrolling content downward (upward finger motion) when scrollTop > 0 or === 0 never dismisses.
    body.scrollTop = 40;
    fireEvent.touchStart(body, { touches: [{ clientX: 180, clientY: 400 }] });
    body.scrollTop = 140;
    fireEvent.touchMove(body, { touches: [{ clientX: 180, clientY: 300 }] });
    fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 180, clientY: 300 }] });
    expect(onClose).not.toHaveBeenCalled();

    // 3. Starting at scrollTop = 120, scrolling up to scrollTop = 0, then pulling down 90px more dismisses!
    body.scrollTop = 120;
    fireEvent.touchStart(body, { touches: [{ clientX: 180, clientY: 240 }] });
    body.scrollTop = 40;
    fireEvent.touchMove(body, { touches: [{ clientX: 180, clientY: 320 }] });
    expect(sheet.style.transform).toBe('');

    // Hit scrollTop = 0 at clientY = 360 -> anchors here!
    body.scrollTop = 0;
    fireEvent.touchMove(body, { touches: [{ clientX: 180, clientY: 360 }] });
    expect(sheet.style.transform).toBe('');

    // Continue pulling down to clientY = 450 (pullDy = 90px >= 56px) -> translates & dismisses on release!
    fireEvent.touchMove(body, { touches: [{ clientX: 182, clientY: 450 }] });
    expect(sheet.style.transform).toBe('translateY(90px)');
    fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 182, clientY: 450 }] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports pull-down-to-dismiss on .k-sheet__header without interfering with the close button', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="AI 解析" closeLabel="关闭">
        <p>body</p>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const header = sheet.querySelector<HTMLElement>('.k-sheet__header')!;

    fireEvent.pointerDown(header, { clientX: 160, clientY: 200, pointerId: 2 });
    fireEvent.pointerMove(header, { clientX: 162, clientY: 280, pointerId: 2 });
    expect(sheet.style.transform).toBe('translateY(80px)');
    fireEvent.pointerUp(header, { clientX: 162, clientY: 280, pointerId: 2 });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('applies non-modal pass-through scrim in peek when modal={false} and restores modal scrim when expanded', () => {
    let now = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const onClose = vi.fn();
      render(
        <BottomSheet open modal={false} onClose={onClose} title="AI 解析">
          <p>body</p>
        </BottomSheet>,
      );
      const sheet = screen.getByRole('dialog');
      const scrim = sheet.parentElement!;
      expect(scrim).toHaveClass('k-bottom-sheet-scrim', 'is-passthrough');
      expect(sheet).toHaveAttribute('aria-modal', 'false');

      // Even after the 350ms guard window, scrim mouseDown does NOT close while in non-modal peek.
      now += 500;
      fireEvent.mouseDown(scrim);
      expect(onClose).not.toHaveBeenCalled();

      // Expanding restores modal scrim and aria-modal="true".
      const handle = screen.getByTestId('bottom-sheet-handle');
      fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 });
      expect(sheet).toHaveClass('is-expanded');
      expect(scrim).not.toHaveClass('is-passthrough');
      expect(sheet).toHaveAttribute('aria-modal', 'true');

      fireEvent.mouseDown(scrim);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('expands from peek to expanded without negative translateY when dragging upward inside .k-sheet__body', () => {
    const onChildClick = vi.fn();
    render(
      <BottomSheet open modal={false} onClose={() => {}} title="AI 解析">
        <div data-testid="card" onClick={onChildClick}>
          意群卡片
        </div>
        <button type="button">操作按钮</button>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const card = screen.getByTestId('card');
    const btn = screen.getByRole('button', { name: '操作按钮' });
    expect(sheet.dataset['snap']).toBe('peek');

    // Dragging upward starting on an interactive button does NOT auto-expand.
    fireEvent.touchStart(btn, { touches: [{ clientX: 180, clientY: 500 }] });
    fireEvent.touchMove(btn, { touches: [{ clientX: 180, clientY: 430 }] });
    fireEvent.touchEnd(btn, { touches: [], changedTouches: [{ clientX: 180, clientY: 430 }] });
    expect(sheet.dataset['snap']).toBe('peek');

    // Dragging upward (dy = -60px) inside .k-sheet__body expands to 'expanded' with zero negative translateY.
    fireEvent.touchStart(card, { touches: [{ clientX: 180, clientY: 500 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 182, clientY: 440 }] });
    expect(sheet).toHaveClass('is-expanded');
    expect(sheet.dataset['snap']).toBe('expanded');
    expect(sheet.style.transform).toBe('');
    fireEvent.touchEnd(card, { touches: [], changedTouches: [{ clientX: 182, clientY: 440 }] });

    // Accidental child click immediately after drag-to-expand is suppressed.
    fireEvent.click(card);
    expect(onChildClick).not.toHaveBeenCalled();
  });
});

describe('BottomSheet close animation & drag release transition', () => {
  it('stays mounted with is-closing and --k-sheet-drag-y: 90px on pull-to-dismiss, and unmounts on animationEnd', () => {
    const onCloseSpy = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <BottomSheet
          open={open}
          onClose={() => {
            onCloseSpy();
            setOpen(false);
          }}
          title="AI 解析"
        >
          <p data-testid="sheet-child">释义内容</p>
        </BottomSheet>
      );
    }

    const { container } = render(<Harness />);
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    body.scrollTop = 0;
    expect(sheet).toHaveClass('is-entering');

    // Pull down 90px (>= 56px dismiss threshold) and release.
    fireEvent.touchStart(body, { touches: [{ clientX: 180, clientY: 260 }] });
    fireEvent.touchMove(body, { touches: [{ clientX: 181, clientY: 350 }] });
    expect(sheet).toHaveClass('is-dragging');
    expect(sheet).not.toHaveClass('is-entering');
    expect(sheet.style.transform).toBe('translateY(90px)');

    fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 181, clientY: 350 }] });

    // 1. onClose fires immediately, while .k-bottom-sheet stays mounted in exit animation state.
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    const closingSheet = container.querySelector<HTMLElement>('.k-bottom-sheet');
    const closingScrim = container.querySelector<HTMLElement>('.k-bottom-sheet-scrim');
    expect(closingSheet).not.toBeNull();
    expect(closingSheet).toHaveClass('is-closing');
    expect(closingSheet).not.toHaveClass('is-entering');
    expect(closingSheet).not.toHaveClass('is-dragging');
    expect(closingSheet).toHaveAttribute('data-closing', 'true');
    expect(closingSheet!.style.getPropertyValue('--k-sheet-drag-y')).toBe('90px');
    expect(closingScrim).toHaveClass('is-closing');
    expect(closingScrim).toHaveAttribute('aria-hidden', 'true');

    // Bubbled animationEnd from a child element must NOT prematurely unmount the sheet.
    fireEvent.animationEnd(screen.getByTestId('sheet-child'));
    expect(container.querySelector('.k-bottom-sheet')).not.toBeNull();

    // Once .k-bottom-sheet finishes its own exit animation, it unmounts cleanly.
    fireEvent.animationEnd(closingSheet!);
    expect(container.querySelector('.k-bottom-sheet')).toBeNull();
    expect(container.querySelector('.k-bottom-sheet-scrim')).toBeNull();
  });

  it('unmounts cleanly after the 240ms fallback timer when animationEnd does not fire, and cancels close if re-opened mid-flight', () => {
    vi.useFakeTimers();
    try {
      function Harness({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
        return (
          <BottomSheet open={open} onClose={onClose} title="AI 解析">
            <p>释义内容</p>
          </BottomSheet>
        );
      }

      const { container, rerender } = render(<Harness open onClose={() => {}} />);
      const header = container.querySelector<HTMLElement>('.k-sheet__header')!;

      // Pull down 80px on header and close via controlled prop update.
      fireEvent.pointerDown(header, { clientX: 160, clientY: 200, pointerId: 3 });
      fireEvent.pointerMove(header, { clientX: 160, clientY: 280, pointerId: 3 });
      fireEvent.pointerUp(header, { clientX: 160, clientY: 280, pointerId: 3 });
      rerender(<Harness open={false} onClose={() => {}} />);

      const closingSheet = container.querySelector<HTMLElement>('.k-bottom-sheet')!;
      expect(closingSheet).toHaveClass('is-closing');
      expect(closingSheet.style.getPropertyValue('--k-sheet-drag-y')).toBe('80px');

      // Re-open mid-close at 100ms -> cancels fallback unmount timer and plays entry animation.
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(container.querySelector('.k-bottom-sheet')).not.toBeNull();

      rerender(<Harness open onClose={() => {}} />);
      const reopenedSheet = container.querySelector<HTMLElement>('.k-bottom-sheet')!;
      expect(reopenedSheet).not.toHaveClass('is-closing');
      expect(reopenedSheet).toHaveClass('is-entering');

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(container.querySelector('.k-bottom-sheet')).not.toBeNull();

      // Close again and let the 240ms fallback timer unmount without animationEnd.
      rerender(<Harness open={false} onClose={() => {}} />);
      expect(container.querySelector('.k-bottom-sheet')).toHaveClass('is-closing');

      act(() => {
        vi.advanceTimersByTime(239);
      });
      expect(container.querySelector('.k-bottom-sheet')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(container.querySelector('.k-bottom-sheet')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('animates out with is-closing and --k-sheet-drag-y: 0px when closed via the close button', () => {
    const onCloseSpy = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <BottomSheet
          open={open}
          onClose={() => {
            onCloseSpy();
            setOpen(false);
          }}
          title="AI 解析"
          closeLabel="关闭"
        >
          <p>释义内容</p>
        </BottomSheet>
      );
    }

    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    const closingSheet = container.querySelector<HTMLElement>('.k-bottom-sheet');
    expect(closingSheet).not.toBeNull();
    expect(closingSheet).toHaveClass('is-closing');
    expect(closingSheet!.style.getPropertyValue('--k-sheet-drag-y')).toBe('0px');

    fireEvent.animationEnd(closingSheet!);
    expect(container.querySelector('.k-bottom-sheet')).toBeNull();
  });

  it('clears is-entering on small non-dismissing pull (< 56px) so k-sheet-up does not replay on release', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="AI 解析">
        <p>释义内容</p>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    body.scrollTop = 0;

    // Starts with is-entering on initial open.
    expect(sheet).toHaveClass('is-entering');

    // Pull down slightly (30px < 56px) and release slowly so neither distance nor velocity dismisses.
    let now = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 300 }] });
      now += 120;
      fireEvent.touchMove(body, { touches: [{ clientX: 201, clientY: 330 }] });
      expect(sheet).toHaveClass('is-dragging');
      expect(sheet).not.toHaveClass('is-entering');
      expect(sheet.style.transform).toBe('translateY(30px)');

      now += 200;
      fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 201, clientY: 330 }] });
    } finally {
      nowSpy.mockRestore();
    }

    expect(onClose).not.toHaveBeenCalled();
    expect(sheet).not.toHaveClass('is-dragging');
    expect(sheet).not.toHaveClass('is-closing');
    expect(sheet).not.toHaveClass('is-entering');
    expect(sheet.style.transform).toBe('');
  });
});

describe('BottomSheet stranded scrollTop (v0.1.44 iOS 这个页面无法滚动)', () => {
  it('resets scrollTop to 0 when dragging up from the top of peek expands the sheet', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    try {
      render(
        <BottomSheet open onClose={() => {}} title="AI 解析">
          <div style={{ height: 900 }}>breakdown</div>
        </BottomSheet>,
      );
      const sheet = screen.getByRole('dialog');
      const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
      mockBodySize(body, 900, 400);
      body.scrollTop = 0;

      fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 500 }] });
      // Native scroll during the first 28px of upward movement.
      body.scrollTop = 64;
      fireEvent.touchMove(body, { touches: [{ clientX: 200, clientY: 460 }] });
      expect(sheet).toHaveClass('is-expanded');
      expect(body.scrollTop).toBe(0);
      fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 200, clientY: 460 }] });
      expect(body.scrollTop).toBe(0);
    } finally {
      rafSpy.mockRestore();
    }
  });

  it('keeps a legitimate in-range scrollTop when the drag-up started mid-content (startScrollTop > 12)', () => {
    render(
      <BottomSheet open onClose={() => {}} title="AI 解析">
        <div style={{ height: 900 }}>breakdown</div>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    mockBodySize(body, 900, 400);
    body.scrollTop = 200;
    fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 500 }] });
    body.scrollTop = 240;
    fireEvent.touchMove(body, { touches: [{ clientX: 200, clientY: 460 }] });
    expect(sheet).toHaveClass('is-expanded');
    expect(body.scrollTop).toBe(240);
  });

  it('clamps a stranded scrollTop when expanding makes the content fit (scrollHeight <= clientHeight)', () => {
    render(
      <BottomSheet open onClose={() => {}} title="AI 解析">
        <div>(ため息)</div>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    const resize = mockBodySize(body, 520, 400);
    body.scrollTop = 60;
    // Expanding to 88vh: the body grows so the 1-chunk breakdown fits.
    resize({ clientHeight: 520 });
    fireEvent.keyDown(screen.getByTestId('bottom-sheet-handle'), { key: 'Enter' });
    expect(sheet).toHaveClass('is-expanded');
    expect(body.scrollTop).toBe(0);
  });

  it('clamps scrollTop above the new max to maxScroll after a snap change', () => {
    render(
      <BottomSheet open onClose={() => {}} title="AI 解析">
        <div style={{ height: 900 }}>breakdown</div>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    const resize = mockBodySize(body, 900, 400);
    body.scrollTop = 500;
    resize({ clientHeight: 700 });
    fireEvent.keyDown(screen.getByTestId('bottom-sheet-handle'), { key: 'Enter' });
    expect(sheet).toHaveClass('is-expanded');
    expect(body.scrollTop).toBe(200);
  });

  it('un-strands a non-zero scrollTop on pull-down when content fits and dismisses instead of deadlocking', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="AI 解析" initialSnap="expanded">
        <div>(ため息)</div>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    mockBodySize(body, 500, 500);
    body.scrollTop = 0;

    fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 300 }] });
    // iOS leaves scrollTop stranded at ~60px although maxScroll is 0.
    body.scrollTop = 60;
    fireEvent.touchMove(body, { touches: [{ clientX: 200, clientY: 304 }] });
    expect(body.scrollTop).toBe(0);
    fireEvent.touchMove(body, { touches: [{ clientX: 201, clientY: 394 }] });
    // Anchored at touchstart (scrollTop was 0 then) → 94px pull.
    expect(sheet.style.transform).toBe('translateY(94px)');
    fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 201, clientY: 394 }] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('un-strands scrollTop already at touchstart so the very first pull-down anchors', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="AI 解析" initialSnap="expanded">
        <div>(ため息)</div>
      </BottomSheet>,
    );
    const sheet = screen.getByRole('dialog');
    const body = sheet.querySelector<HTMLElement>('.k-sheet__body')!;
    mockBodySize(body, 480, 500);
    body.scrollTop = 58;

    fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 300 }] });
    expect(body.scrollTop).toBe(0);
    fireEvent.touchMove(body, { touches: [{ clientX: 200, clientY: 380 }] });
    expect(sheet.style.transform).toBe('translateY(80px)');
    fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 200, clientY: 380 }] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
