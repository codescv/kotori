/** M3 segmented button (single-select). */
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface Segment<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
  readonly disabled?: boolean;
}

export interface SegmentedButtonProps<T extends string> {
  readonly segments: readonly Segment<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label?: string;
  readonly className?: string | undefined;
  readonly dense?: boolean;
}

export function SegmentedButton<T extends string>({ segments, value, onChange, label, className, dense }: SegmentedButtonProps<T>) {
  return (
    <div className={cx('k-segmented', dense && 'k-segmented--dense', className)} role="radiogroup" aria-label={label}>
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={s.disabled}
            className={cx('k-segmented__item', selected && 'is-selected')}
            onClick={() => onChange(s.value)}
          >
            {selected ? <Icon name="check" size={18} /> : s.icon ? <Icon name={s.icon} size={18} /> : null}
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
