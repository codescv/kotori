/** M3 icon button (standard · filled · tonal · outlined), optionally a toggle. */
import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly icon: IconName;
  /** Accessible name (also used as tooltip). */
  readonly label: string;
  readonly variant?: 'standard' | 'filled' | 'tonal' | 'outlined';
  /** When defined the button is a toggle (`aria-pressed`). */
  readonly selected?: boolean;
  readonly size?: 'small' | 'medium';
}

export function IconButton({ icon, label, variant = 'standard', selected, size = 'medium', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('k-icon-btn', `k-icon-btn--${variant}`, size === 'small' && 'k-icon-btn--small', selected && 'is-selected', className)}
      aria-label={label}
      title={label}
      aria-pressed={selected}
      {...rest}
    >
      <Icon name={icon} size={size === 'small' ? 20 : 24} />
    </button>
  );
}
