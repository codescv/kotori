import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
