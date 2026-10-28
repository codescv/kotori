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

  it('drag up expands, drag down from expanded returns to peek, and a long drag down from peek closes', () => {
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
    fireEvent.pointerUp(handle, { clientY: 180, pointerId: 1 });
    expect(sheet).toHaveClass('is-peek');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 700, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 700, pointerId: 1 });
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
});
