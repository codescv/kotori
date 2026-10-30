/** M3 menu anchored to a trigger; closes on outside click / Esc / selection. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { registerBackInterceptor } from '../../app/routes';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly icon?: IconName;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly testId?: string | undefined;
}

export interface MenuHeading {
  readonly key: string;
  readonly heading: ReactNode;
}

export interface MenuProps {
  readonly trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  readonly items: readonly (MenuItem | MenuHeading)[];
  readonly align?: 'start' | 'end';
  readonly className?: string | undefined;
  readonly header?: ReactNode;
  readonly children?: ReactNode;
}

export function Menu({ trigger, items, align = 'end', className, header, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    return registerBackInterceptor(() => {
      setOpen(false);
      return true;
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div className={cx('k-menu-anchor', className)} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={cx('k-menu', `k-menu--${align}`)} role="menu">
          {header && <div className="k-menu__header">{header}</div>}
          {items.map((it) =>
            'heading' in it ? (
              <div key={it.key} className="k-menu__heading" role="presentation">
                {it.heading}
              </div>
            ) : (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                data-testid={it.testId}
                className={cx('k-menu__item', it.selected && 'is-selected')}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon ? <Icon name={it.icon} size={20} /> : it.selected ? <Icon name="check" size={20} /> : <span className="k-menu__spacer" />}
                <span className="k-menu__label" title={typeof it.label === 'string' ? it.label : undefined}>
                  {it.label}
                </span>
              </button>
            ),
          )}
          {children}
        </div>
      )}
    </div>
  );
}
