/** M3 switch. */
import { useId } from 'react';
import { cx } from './cx';

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label?: string;
  readonly supportingText?: string;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
}

export function Switch({ checked, onChange, label, supportingText, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <label className={cx('k-switch-row', disabled && 'is-disabled', className)} htmlFor={id}>
      {(label || supportingText) && (
        <span className="k-switch-row__text">
          {label && <span className="k-switch-row__label">{label}</span>}
          {supportingText && <span className="k-switch-row__support">{supportingText}</span>}
        </span>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={cx('k-switch', checked && 'is-checked')}
        onClick={() => onChange(!checked)}
      >
        <span className="k-switch__handle" />
      </button>
    </label>
  );
}
