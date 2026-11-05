/**
 * jsdom has no `PointerEvent`, so Testing Library falls back to a bare `Event` and
 * drops `pointerType` / `pointerId` / `clientX` / `button`. Tests exercising mouse /
 * pen pointer gestures install this minimal MouseEvent-based stand-in.
 */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}

/** Installs the stand-in when missing; returns an uninstall callback. */
export function installPointerEventPolyfill(): () => void {
  if (typeof window === 'undefined' || 'PointerEvent' in window) return () => {};
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: TestPointerEvent });
  return () => {
    delete (window as { PointerEvent?: unknown }).PointerEvent;
  };
}
