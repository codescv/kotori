/** M3 menu anchored to a trigger; closes on outside click / Esc / selection. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly icon?: IconName;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}

export interface MenuProps {
  readonly trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  readonly items: readonly MenuItem[];
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
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={cx('k-menu-anchor', className)} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={cx('k-menu', `k-menu--${align}`)} role="menu">
          {header && <div className="k-menu__header">{header}</div>}
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={cx('k-menu__item', item.selected && 'is-selected')}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon ? <Icon name={item.icon} size={20} /> : item.selected ? <Icon name="check" size={20} /> : <span className="k-menu__spacer" />}
              <span>{item.label}</span>
            </button>
          ))}
          {children}
        </div>
      )}
    </div>
  );
}
