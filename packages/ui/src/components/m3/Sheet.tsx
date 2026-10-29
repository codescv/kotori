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
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly closeLabel?: string;
}

/** Docked (non-modal) side sheet; lives in the layout flow next to content. */
export function SideSheet({ open, onClose, title, headerActions, children, className, closeLabel = 'close', width }: SheetProps & { readonly width?: number | undefined }) {
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
 * Tapping the handle toggles the snap; dragging up expands, dragging down from
 * `expanded` returns to `peek`, and dragging down > 30% (or a flick) dismisses.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  headerActions,
  children,
  className,
  closeLabel = 'close',
  initialSnap = 'peek',
}: SheetProps & { readonly initialSnap?: BottomSheetSnap }) {
  const [dragY, setDragY] = useState(0);
  const [snap, setSnap] = useState<BottomSheetSnap>(initialSnap);
  const start = useRef<{ y: number; t: number } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    openedAtRef.current = performance.now();
    setDragY(0);
    setSnap(initialSnap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const toggleSnap = (): void => setSnap((s) => (s === 'peek' ? 'expanded' : 'peek'));
  return (
    <div
      className="k-bottom-sheet-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && performance.now() - openedAtRef.current >= 350) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className={cx('k-bottom-sheet', snap === 'peek' ? 'is-peek' : 'is-expanded', className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        data-snap={snap}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
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
          onPointerDown={(e) => {
            start.current = { y: e.clientY, t: performance.now() };
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => start.current && setDragY(Math.max(0, e.clientY - start.current.y))}
          onPointerUp={(e) => {
            const s = start.current;
            start.current = null;
            if (!s) return;
            const dy = e.clientY - s.y;
            const velocity = dy / Math.max(1, performance.now() - s.t);
            const h = sheetRef.current?.offsetHeight || 400;
            setDragY(0);
            if (Math.abs(dy) < 6) toggleSnap();
            else if (dy < -24 || velocity < -0.5) setSnap('expanded');
            else if (dy > h * 0.3 || velocity > 0.8) {
              if (snap === 'expanded' && dy < h * 0.6) setSnap('peek');
              else onClose();
            } else if (snap === 'expanded' && dy > 48) setSnap('peek');
          }}
          onPointerCancel={() => {
            start.current = null;
            setDragY(0);
          }}
        >
          <span className="k-bottom-sheet__handle" />
        </div>
        {(title || headerActions) && (
          <header className="k-sheet__header">
            <h2 className="k-sheet__title">{title}</h2>
            <div className="k-sheet__header-actions">
              {headerActions}
              <IconButton icon="close" label={closeLabel} onClick={onClose} data-dialog-close />
            </div>
          </header>
        )}
        <div className="k-sheet__body">{children}</div>
      </div>
    </div>
  );
}

/** SideSheet on expanded windows (≥ 840 × 500 px), BottomSheet below. */
export function AdaptiveSheet({ initialSnap, ...props }: SheetProps & { readonly width?: number | undefined; readonly initialSnap?: BottomSheetSnap }) {
  const expanded = useIsExpanded();
  return expanded ? <SideSheet {...props} /> : <BottomSheet {...props} {...(initialSnap ? { initialSnap } : {})} />;
}
