/** M3 list item (one/two/three-line) with leading/trailing slots. */
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface ListItemProps {
  readonly headline: ReactNode;
  readonly supporting?: ReactNode;
  readonly overline?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  /** Secondary action rendered next to (not inside) an interactive item, so it may be its own button. */
  readonly action?: ReactNode;
  readonly onClick?: () => void;
  readonly selected?: boolean;
  readonly className?: string | undefined;
  readonly disabled?: boolean;
}

export function ListItem({ headline, supporting, overline, leading, trailing, action, onClick, selected, className, disabled }: ListItemProps) {
  const content = (
    <>
      {leading && <span className="k-list-item__leading">{leading}</span>}
      <span className="k-list-item__text">
        {overline && <span className="k-list-item__overline">{overline}</span>}
        <span className="k-list-item__headline">{headline}</span>
        {supporting && <span className="k-list-item__supporting">{supporting}</span>}
      </span>
      {trailing && <span className="k-list-item__trailing">{trailing}</span>}
    </>
  );
  const cls = cx('k-list-item', onClick && 'k-list-item--interactive', selected && 'is-selected', className);
  return onClick ? (
    <li className={cx('k-list-li', action !== undefined && 'k-list-li--with-action')}>
      <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-current={selected || undefined}>
        {content}
      </button>
      {action !== undefined && <span className="k-list-item__action">{action}</span>}
    </li>
  ) : (
    <li className={cx('k-list-li', cls)}>
      {content}
      {action !== undefined && <span className="k-list-item__action">{action}</span>}
    </li>
  );
}

export function List({ children, className, label }: { readonly children?: ReactNode; readonly className?: string | undefined; readonly label?: string }) {
  return (
    <ul className={cx('k-list', className)} aria-label={label}>
      {children}
    </ul>
  );
}
