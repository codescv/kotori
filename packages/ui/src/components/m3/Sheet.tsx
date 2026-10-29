/**
 * M3 side sheet (docked on expanded windows) and modal bottom sheet (phones),
 * plus `AdaptiveSheet` which picks one by window size class.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useIsExpanded } from '../../hooks/useMediaQuery';
import { cx } from './cx';
import { IconButton } from './IconButton';

export interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: ReactNode;
  readonly headerActions?: ReactNode;
  readonly footer?: ReactNode;
  readonly modal?: boolean | undefined;
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly closeLabel?: string;
}

/** Docked (non-modal) side sheet; lives in the layout flow next to content. */
export function SideSheet({ open, onClose, title, headerActions, footer, children, className, closeLabel = 'close', width }: SheetProps & { readonly width?: number | undefined }) {
  return (
    <aside
      className={cx('k-side-sheet', open && 'is-open', className)}
      style={width !== undefined ? { ['--k-side-sheet-width' as string]: `${width}px` } : undefined}
      aria-hidden={!open}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      {open && (
        <>
          <header className="k-sheet__header">
            <h2 className="k-sheet__title">{title}</h2>
            <div className="k-sheet__header-actions">
              {headerActions}
              <IconButton icon="close" label={closeLabel} onClick={onClose} data-dialog-close />
            </div>
          </header>
          <div className="k-sheet__body">{children}</div>
          {footer !== undefined && <footer className="k-sheet__footer">{footer}</footer>}
        </>
      )}
    </aside>
  );
}

export type BottomSheetSnap = 'peek' | 'expanded';

/**
 * Modal bottom sheet with drag handle and two snap points:
 * - `peek` (default, ≈ 52vh) keeps the manga bubble / video frame visible above it;
 * - `expanded` (88vh) for reading long breakdowns.
 * Tapping the handle toggles the snap; dragging up expands, and pulling down
 * on the handle, header, or scroll-top body dismisses the sheet smoothly.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  headerActions,
  footer,
  modal = true,
  children,
  className,
  closeLabel = 'close',
  initialSnap = 'peek',
}: SheetProps & { readonly initialSnap?: BottomSheetSnap }) {
  const [dragY, setDragY] = useState(0);
  const [snap, setSnap] = useState<BottomSheetSnap>(initialSnap);
  const snapRef = useRef<BottomSheetSnap>(snap);
  snapRef.current = snap;
  const start = useRef<{ y: number; lastY: number; t: number } | null>(null);
  const headerPullRef = useRef<{
    startX: number;
    startY: number;
    lastY: number;
    startTime: number;
    pointerId?: number | undefined;
    active: boolean;
  } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyPullRef = useRef<{
    startX: number;
    startY: number;
    lastY: number;
    anchorX: number;
    anchorY: number | null;
    anchorTime: number;
    pointerId?: number | undefined;
    active: boolean;
    expandedOnPullUp: boolean;
    fromInteractive: boolean;
  } | null>(null);
  const suppressBodyClickRef = useRef(false);
  const suppressHeaderClickRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openedAtRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    openedAtRef.current = performance.now();
    setDragY(0);
    setSnap(initialSnap);
    snapRef.current = initialSnap;
    start.current = null;
    headerPullRef.current = null;
    bodyPullRef.current = null;
    suppressBodyClickRef.current = false;
    suppressHeaderClickRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const beginBodyPull = (clientX: number, clientY: number, target: EventTarget | null, pointerId?: number): void => {
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;
    if (target instanceof Element && target.closest('input[type="range"]')) return;
    const fromInteractive =
      target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, [role="slider"]'));
    suppressBodyClickRef.current = false;
    bodyPullRef.current = {
      startX: clientX,
      startY: clientY,
      lastY: clientY,
      anchorX: clientX,
      anchorY: bodyEl.scrollTop <= 1 ? clientY : null,
      anchorTime: performance.now(),
      pointerId,
      active: false,
      expandedOnPullUp: false,
      fromInteractive,
    };
  };

  const moveBodyPull = (clientX: number, clientY: number, cancelEvent?: () => void): void => {
    const state = bodyPullRef.current;
    const bodyEl = bodyRef.current;
    if (!state || !bodyEl) return;
    const dx = clientX - state.startX;
    const dy = clientY - state.startY;
    state.lastY = clientY;

    if (!state.active && !state.fromInteractive && snapRef.current === 'peek' && dy < -28 && Math.abs(dy) > Math.abs(dx) * 1.15) {
      snapRef.current = 'expanded';
      state.expandedOnPullUp = true;
      openedAtRef.current = -1000;
      setSnap('expanded');
      return;
    }

    if (!state.active) {
      if (bodyEl.scrollTop > 1) {
        state.anchorY = null;
        return;
      }
      if (state.anchorY === null) {
        state.anchorX = clientX;
        state.anchorY = clientY;
        state.anchorTime = performance.now();
      }
      const pullDx = clientX - state.anchorX;
      const pullDy = clientY - state.anchorY;
      const minPull = state.fromInteractive ? 8 : 6;
      if (pullDy > minPull && pullDy > Math.abs(pullDx) * 1.1 && (!state.fromInteractive || Math.abs(dy) > 8)) {
        state.active = true;
        if (state.pointerId !== undefined) {
          try {
            bodyEl.setPointerCapture?.(state.pointerId);
          } catch {
            // Ignore synthetic events without an active browser pointer.
          }
        }
      }
    }

    if (state.active && state.anchorY !== null) {
      const pullDy = clientY - state.anchorY;
      if (pullDy > 0) {
        cancelEvent?.();
        setDragY(pullDy);
      } else {
        setDragY(0);
        state.active = false;
        state.anchorY = null;
      }
    }
  };

  const endBodyPull = (): void => {
    const state = bodyPullRef.current;
    bodyPullRef.current = null;
    if (!state) return;
    if (state.expandedOnPullUp) {
      suppressBodyClickRef.current = true;
      setTimeout(() => {
        suppressBodyClickRef.current = false;
      }, 80);
    }
    if (state.active && state.anchorY !== null) {
      const pullDy = Math.max(0, state.lastY - state.anchorY);
      const velocity = pullDy / Math.max(1, performance.now() - state.anchorTime);
      setDragY(0);
      suppressBodyClickRef.current = true;
      setTimeout(() => {
        suppressBodyClickRef.current = false;
      }, 80);
      if (pullDy >= 56 || (pullDy >= 24 && velocity > 0.5)) {
        onCloseRef.current();
      }
    }
  };

  const cancelBodyPull = (): void => {
    if (bodyPullRef.current?.active) setDragY(0);
    bodyPullRef.current = null;
  };

  useEffect(() => {
    if (!open) return;
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;
    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1) {
        cancelBodyPull();
        return;
      }
      const t = e.touches[0]!;
      beginBodyPull(t.clientX, t.clientY, e.target, undefined);
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (e.touches.length !== 1) {
        cancelBodyPull();
        return;
      }
      const t = e.touches[0]!;
      moveBodyPull(t.clientX, t.clientY, () => {
        if (e.cancelable) e.preventDefault();
      });
    };
    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length > 0) return;
      if (bodyPullRef.current && e.changedTouches[0]) {
        bodyPullRef.current.lastY = e.changedTouches[0].clientY;
      }
      endBodyPull();
    };
    const onTouchCancel = (): void => {
      cancelBodyPull();
    };
    bodyEl.addEventListener('touchstart', onTouchStart, { passive: true });
    bodyEl.addEventListener('touchmove', onTouchMove, { passive: false });
    bodyEl.addEventListener('touchend', onTouchEnd);
    bodyEl.addEventListener('touchcancel', onTouchCancel);
    return () => {
      bodyEl.removeEventListener('touchstart', onTouchStart);
      bodyEl.removeEventListener('touchmove', onTouchMove);
      bodyEl.removeEventListener('touchend', onTouchEnd);
      bodyEl.removeEventListener('touchcancel', onTouchCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const expandSnap = (): void => {
    snapRef.current = 'expanded';
    openedAtRef.current = -1000;
    setSnap('expanded');
  };
  const toggleSnap = (): void => {
    if (snapRef.current === 'peek') expandSnap();
    else {
      snapRef.current = 'peek';
      setSnap('peek');
    }
  };

  const finishHandleDrag = (endY: number): void => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dy = endY - s.y;
    const velocity = dy / Math.max(1, performance.now() - s.t);
    setDragY(0);
    if (Math.abs(dy) < 6) toggleSnap();
    else if (dy < -24 || velocity < -0.5) expandSnap();
    else if (dy >= 56 || (dy >= 24 && velocity > 0.55)) onCloseRef.current();
  };

  const isHeaderActionTarget = (target: EventTarget | null): boolean =>
    target instanceof Element && Boolean(target.closest('.k-sheet__header-actions, button, a, input, select, textarea, [role="slider"]'));

  const moveHeaderPull = (clientX: number, clientY: number, headerEl?: HTMLElement): void => {
    const s = headerPullRef.current;
    if (!s) return;
    const dx = clientX - s.startX;
    const dy = clientY - s.startY;
    s.lastY = clientY;
    if (!s.active && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx) * 1.1) {
      s.active = true;
      if (s.pointerId !== undefined && headerEl) {
        try {
          headerEl.setPointerCapture?.(s.pointerId);
        } catch {
          // Ignore synthetic events without an active browser pointer.
        }
      }
    }
    if (s.active) {
      if (snapRef.current === 'peek' && dy < -28 && Math.abs(dy) > Math.abs(dx) * 1.15) {
        expandSnap();
      }
      setDragY(Math.max(0, dy));
    }
  };

  const finishHeaderPull = (): void => {
    const s = headerPullRef.current;
    headerPullRef.current = null;
    if (!s) return;
    const dy = s.lastY - s.startY;
    const velocity = dy / Math.max(1, performance.now() - s.startTime);
    setDragY(0);
    if (!s.active) return;
    suppressHeaderClickRef.current = true;
    setTimeout(() => {
      suppressHeaderClickRef.current = false;
    }, 80);
    if (dy >= 56 || (dy >= 24 && velocity > 0.5)) onCloseRef.current();
    else if (dy < -24 || velocity < -0.5) expandSnap();
  };

  const isPassthrough = !modal && snap === 'peek';
  const isModal = modal || snap === 'expanded';

  return (
    <div
      className={cx('k-bottom-sheet-scrim', isPassthrough && 'is-passthrough')}
      onMouseDown={(e) => {
        if (isModal && e.target === e.currentTarget && performance.now() - openedAtRef.current >= 350) onClose();
      }}
    >
      <div
        className={cx('k-bottom-sheet', snap === 'peek' ? 'is-peek' : 'is-expanded', dragY > 0 && 'is-dragging', className)}
        role="dialog"
        aria-modal={isModal ? 'true' : 'false'}
        aria-label={typeof title === 'string' ? title : undefined}
        data-snap={snap}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: 'none', animation: 'none' } : undefined}
      >
        <div
          className="k-bottom-sheet__handle-area"
          role="button"
          tabIndex={0}
          aria-expanded={snap === 'expanded'}
          aria-label={snap === 'peek' ? '展开面板' : '收起面板'}
          data-testid="bottom-sheet-handle"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleSnap();
            }
          }}
          onTouchStart={(e) => {
            if (e.touches.length !== 1) return;
            const y = e.touches[0]!.clientY;
            start.current = { y, lastY: y, t: performance.now() };
          }}
          onTouchMove={(e) => {
            if (!start.current || e.touches.length !== 1) return;
            const y = e.touches[0]!.clientY;
            start.current.lastY = y;
            setDragY(Math.max(0, y - start.current.y));
          }}
          onTouchEnd={(e) => {
            if (!start.current || e.touches.length > 0) return;
            const endY = e.changedTouches[0]?.clientY ?? start.current.lastY;
            finishHandleDrag(endY);
          }}
          onTouchCancel={() => {
            start.current = null;
            setDragY(0);
          }}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch') return;
            start.current = { y: e.clientY, lastY: e.clientY, t: performance.now() };
            try {
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            } catch {
              // Ignore synthetic events without an active browser pointer.
            }
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch' || !start.current) return;
            start.current.lastY = e.clientY;
            setDragY(Math.max(0, e.clientY - start.current.y));
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch' || !start.current) return;
            finishHandleDrag(e.clientY);
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch') return;
            start.current = null;
            setDragY(0);
          }}
        >
          <span className="k-bottom-sheet__handle" />
        </div>
        <header
          className="k-sheet__header"
          onTouchStart={(e) => {
            if (e.touches.length !== 1 || isHeaderActionTarget(e.target)) return;
            const t = e.touches[0]!;
            suppressHeaderClickRef.current = false;
            headerPullRef.current = {
              startX: t.clientX,
              startY: t.clientY,
              lastY: t.clientY,
              startTime: performance.now(),
              active: false,
            };
          }}
          onTouchMove={(e) => {
            if (!headerPullRef.current || e.touches.length !== 1) return;
            const t = e.touches[0]!;
            moveHeaderPull(t.clientX, t.clientY);
          }}
          onTouchEnd={(e) => {
            if (!headerPullRef.current || e.touches.length > 0) return;
            if (e.changedTouches[0]) headerPullRef.current.lastY = e.changedTouches[0].clientY;
            finishHeaderPull();
          }}
          onTouchCancel={() => {
            headerPullRef.current = null;
            setDragY(0);
          }}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch' || e.button !== 0 || isHeaderActionTarget(e.target)) return;
            suppressHeaderClickRef.current = false;
            headerPullRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              lastY: e.clientY,
              startTime: performance.now(),
              pointerId: e.pointerId,
              active: false,
            };
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch' || headerPullRef.current?.pointerId !== e.pointerId) return;
            moveHeaderPull(e.clientX, e.clientY, e.currentTarget);
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch' || headerPullRef.current?.pointerId !== e.pointerId) return;
            if (e.clientY !== 0 || headerPullRef.current.startY === 0) headerPullRef.current.lastY = e.clientY;
            finishHeaderPull();
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch' || headerPullRef.current?.pointerId !== e.pointerId) return;
            headerPullRef.current = null;
            setDragY(0);
          }}
          onClickCapture={(e) => {
            if (suppressHeaderClickRef.current) {
              suppressHeaderClickRef.current = false;
              if (!isHeaderActionTarget(e.target)) {
                e.stopPropagation();
                e.preventDefault();
              }
            }
          }}
        >
          <h2 className="k-sheet__title">{title}</h2>
          <div className="k-sheet__header-actions">
            {headerActions}
            <IconButton icon="close" label={closeLabel} onClick={onClose} data-dialog-close />
          </div>
        </header>
        <div
          ref={bodyRef}
          className="k-sheet__body"
          onPointerDown={(e) => {
            if (e.pointerType === 'touch' || e.button !== 0) return;
            beginBodyPull(e.clientX, e.clientY, e.target, e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch' || bodyPullRef.current?.pointerId !== e.pointerId) return;
            moveBodyPull(e.clientX, e.clientY, () => {
              if (e.cancelable) e.preventDefault();
            });
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch' || bodyPullRef.current?.pointerId !== e.pointerId) return;
            if (e.clientY !== 0 || bodyPullRef.current.startY === 0) {
              bodyPullRef.current.lastY = e.clientY;
            }
            endBodyPull();
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch' || bodyPullRef.current?.pointerId !== e.pointerId) return;
            cancelBodyPull();
          }}
          onClickCapture={(e) => {
            if (suppressBodyClickRef.current) {
              suppressBodyClickRef.current = false;
              e.stopPropagation();
              e.preventDefault();
            }
          }}
        >
          {children}
        </div>
        {footer !== undefined && <footer className="k-sheet__footer">{footer}</footer>}
      </div>
    </div>
  );
}

/** SideSheet on expanded windows (≥ 840 × 500 px), BottomSheet below. */
export function AdaptiveSheet({ initialSnap, ...props }: SheetProps & { readonly width?: number | undefined; readonly initialSnap?: BottomSheetSnap }) {
  const expanded = useIsExpanded();
  return expanded ? <SideSheet {...props} /> : <BottomSheet {...props} {...(initialSnap ? { initialSnap } : {})} />;
}
