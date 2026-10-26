/** M3 slider (native range input styled with tokens; keyboard accessible). */
import { useId, type CSSProperties } from 'react';
import { cx } from './cx';

export interface SliderProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly label?: string;
  readonly format?: (value: number) => string;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
}

export function Slider({ value, onChange, min = 0, max = 100, step = 1, label, format, disabled, className }: SliderProps) {
  const id = useId();
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={cx('k-slider', className)}>
      {label && (
        <label className="k-slider__label" htmlFor={id}>
          <span>{label}</span>
          <span className="k-slider__value">{format ? format(value) : value}</span>
        </label>
      )}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--k-slider-pct': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </div>
  );
}
