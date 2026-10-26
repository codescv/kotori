/** M3 chips: assist · filter (toggle) · input · suggestion. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly kind?: 'assist' | 'filter' | 'input' | 'suggestion';
  readonly icon?: IconName;
  readonly selected?: boolean;
  readonly onRemove?: () => void;
  readonly children?: ReactNode;
}

export function Chip({ kind = 'assist', icon, selected, onRemove, className, children, type = 'button', ...rest }: ChipProps) {
  return (
    <span className={cx('k-chip-wrap')}>
      <button
        type={type}
        className={cx('k-chip', `k-chip--${kind}`, selected && 'is-selected', className)}
        aria-pressed={kind === 'filter' ? Boolean(selected) : undefined}
        {...rest}
      >
        {kind === 'filter' && selected ? <Icon name="check" size={18} /> : icon ? <Icon name={icon} size={18} /> : null}
        <span>{children}</span>
      </button>
      {onRemove && (
        <button type="button" className="k-chip__remove" aria-label="remove" onClick={onRemove}>
          <Icon name="close" size={16} />
        </button>
      )}
    </span>
  );
}

export function AssistChip(props: Omit<ChipProps, 'kind'>) {
  return <Chip kind="assist" {...props} />;
}
