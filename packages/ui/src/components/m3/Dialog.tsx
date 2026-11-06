/** M3 basic dialog: scrim, Esc / scrim click to dismiss, initial focus, headline + actions. */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerBackInterceptor } from '../../app/routes';
import { cx } from './cx';
import { useIsInactiveTabSlide } from './tabSlideContext';
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
  readonly 'data-testid'?: string | undefined;
}

const AUTOFOCUS_SELECTOR = '[data-autofocus]:not([data-autofocus="false"]), [autofocus]';
const FOCUSABLE_SELECTOR = 'input:not([type="hidden"]):not([hidden]), textarea, select, button:not([data-dialog-close])';

/**
 * Initial dialog focus (runs once per `open` transition): an explicit
 * `[data-autofocus]` / `[autofocus]` element wins, otherwise the first field or
 * button. Never steals focus from an element already focused inside the dialog.
 */
function focusInitial(root: HTMLElement | null): void {
  if (!root) return;
  if (typeof document !== 'undefined' && document.activeElement && root.contains(document.activeElement)) return;
  const target =
    root.querySelector<HTMLElement>(AUTOFOCUS_SELECTOR) ?? root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  target?.focus();
}

export function Dialog({ open, onClose, title, icon, children, actions, className, wide, 'data-testid': testId }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers usually pass an inline (unmemoized) `onClose`; keep the latest one in a
  // ref so the effects below depend on `open` only. Otherwise every keystroke in a
  // nested field re-renders the caller, re-runs the effects, re-registers the back
  // interceptor and — worst of all — re-runs initial focus, yanking the caret back
  // into the dialog's first input while the user is typing elsewhere.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // A dialog owned by a peeked / exiting <TabPager> slide stays closed: it must not
  // take focus ([data-autofocus]) or Android back away from the visible page.
  const inactiveSlide = useIsInactiveTabSlide();
  const shown = open && !inactiveSlide;
  useEffect(() => {
    if (!shown) return;
    return registerBackInterceptor(() => {
      onCloseRef.current();
      return true;
    });
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    focusInitial(ref.current);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown]);
  if (!shown) return null;
  const node = (
    <div className="k-dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCloseRef.current()}>
      <div
        ref={ref}
        className={cx('k-dialog', wide && 'k-dialog--wide', className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        data-testid={testId}
      >
        {icon && <Icon name={icon} className="k-dialog__icon" />}
        <h2 className="k-dialog__headline">{title}</h2>
        <div className="k-dialog__content">{children}</div>
        {actions && <div className="k-dialog__actions">{actions}</div>}
      </div>
    </div>
  );
  const portalTarget = (typeof document !== 'undefined' && (document.fullscreenElement as HTMLElement | null)) || (typeof document !== 'undefined' ? document.body : null);
  return !portalTarget ? node : createPortal(node, portalTarget);
}
