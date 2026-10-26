/** M3 text field (outlined / filled), single- or multi-line, with supporting/error text. */
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

interface BaseProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly variant?: 'outlined' | 'filled';
  readonly supportingText?: ReactNode;
  readonly error?: string | undefined;
  readonly leadingIcon?: IconName;
  readonly trailing?: ReactNode;
  readonly className?: string | undefined;
}

export type TextFieldProps = BaseProps &
  (
    | ({ readonly multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>)
    | ({ readonly multiline: true; readonly rows?: number } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'className'>)
  );

export function TextField(props: TextFieldProps) {
  const { label, value, onValueChange, variant = 'outlined', supportingText, error, leadingIcon, trailing, className, ...rest } = props;
  const id = useId();
  const helpId = `${id}-help`;
  const hasHelp = Boolean(error || supportingText);
  const common = {
    id,
    value,
    placeholder: ' ',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': hasHelp ? helpId : undefined,
    className: 'k-field__input',
  } as const;
  return (
    <div className={cx('k-field', `k-field--${variant}`, error && 'is-error', leadingIcon && 'has-leading', className)}>
      <div className="k-field__box">
        {leadingIcon && <Icon name={leadingIcon} size={20} className="k-field__leading" />}
        {rest.multiline ? (
          <textarea
            {...(({ multiline: _m, ...r }) => r)(rest)}
            {...common}
            onChange={(e) => onValueChange(e.currentTarget.value)}
          />
        ) : (
          <input
            {...(({ multiline: _m, ...r }) => r)(rest)}
            {...common}
            onChange={(e) => onValueChange(e.currentTarget.value)}
          />
        )}
        <label htmlFor={id} className="k-field__label">
          {label}
        </label>
        {trailing && <span className="k-field__trailing">{trailing}</span>}
      </div>
      {hasHelp && (
        <div id={helpId} className="k-field__help" role={error ? 'alert' : undefined}>
          {error ?? supportingText}
        </div>
      )}
    </div>
  );
}
