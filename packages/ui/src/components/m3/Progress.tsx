/** M3 linear & circular progress indicators (determinate when `value` is set). */
import { cx } from './cx';

export interface ProgressProps {
  /** 0..1; omit for indeterminate. */
  readonly value?: number;
  readonly className?: string | undefined;
  readonly label?: string;
}

export function LinearProgress({ value, className, label }: ProgressProps) {
  const determinate = value !== undefined;
  const pct = determinate ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined;
  return (
    <div
      className={cx('k-linear-progress', !determinate && 'is-indeterminate', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="k-linear-progress__bar" style={determinate ? { width: `${pct}%` } : undefined} />
    </div>
  );
}

export function CircularProgress({ value, className, label, size = 40 }: ProgressProps & { readonly size?: number }) {
  const determinate = value !== undefined;
  const r = 18;
  const c = 2 * Math.PI * r;
  const pct = determinate ? Math.min(1, Math.max(0, value)) : 0.25;
  return (
    <svg
      className={cx('k-circular-progress', !determinate && 'is-indeterminate', className)}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="progressbar"
      aria-label={label}
      aria-valuenow={determinate ? Math.round(pct * 100) : undefined}
    >
      <circle className="k-circular-progress__track" cx="20" cy="20" r={r} fill="none" strokeWidth="4" />
      <circle
        className="k-circular-progress__bar"
        cx="20"
        cy="20"
        r={r}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform="rotate(-90 20 20)"
      />
    </svg>
  );
}
