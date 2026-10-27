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
export function SideSheet({ open, onClose, title, headerActions, children, className, closeLabel = 'close', width = 420 }: SheetProps & { readonly width?: number }) {
  return (
    <aside
      className={cx('k-side-sheet', open && 'is-open', className)}
      style={{ ['--k-side-sheet-width' as string]: `${width}px` }}
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

/** Modal bottom sheet with drag handle; drag down > 30% (or flick) dismisses. */
export function BottomSheet({ open, onClose, title, headerActions, children, className, closeLabel = 'close' }: SheetProps) {
  const [dragY, setDragY] = useState(0);
  const start = useRef<{ y: number; t: number } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    openedAtRef.current = performance.now();
    setDragY(0);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="k-bottom-sheet-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && performance.now() - openedAtRef.current >= 350) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className={cx('k-bottom-sheet', className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
      >
        <div
          className="k-bottom-sheet__handle-area"
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
            const h = sheetRef.current?.offsetHeight ?? 400;
            if (dy > h * 0.3 || velocity > 0.8) onClose();
            else setDragY(0);
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

/** SideSheet on ≥ 840 px windows, BottomSheet below. */
export function AdaptiveSheet(props: SheetProps & { readonly width?: number }) {
  const expanded = useIsExpanded();
  return expanded ? <SideSheet {...props} /> : <BottomSheet {...props} />;
}
