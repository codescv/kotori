/** M3 common buttons: filled · tonal · outlined · text · elevated. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly icon?: IconName;
  readonly trailingIcon?: IconName;
  readonly children?: ReactNode;
}

export function Button({ variant = 'filled', icon, trailingIcon, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx('k-btn', `k-btn--${variant}`, icon && 'k-btn--with-icon', className)} {...rest}>
      {icon && <Icon name={icon} size={18} />}
      <span className="k-btn__label">{children}</span>
      {trailingIcon && <Icon name={trailingIcon} size={18} />}
    </button>
  );
}
