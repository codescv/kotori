/** M3 basic dialog: scrim, Esc / scrim click to dismiss, initial focus, headline + actions. */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly icon?: IconName;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string | undefined;
  /** Wide variant for forms / path browsers. */
  readonly wide?: boolean;
}

export function Dialog({ open, onClose, title, icon, children, actions, className, wide }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-dialog-close])');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  const node = (
    <div className="k-dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx('k-dialog', wide && 'k-dialog--wide', className)} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        {icon && <Icon name={icon} className="k-dialog__icon" />}
        <h2 className="k-dialog__headline">{title}</h2>
        <div className="k-dialog__content">{children}</div>
        {actions && <div className="k-dialog__actions">{actions}</div>}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? node : createPortal(node, document.body);
}
