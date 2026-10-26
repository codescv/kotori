/** M3 primary tabs with an animated active indicator. */
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
  readonly badge?: number;
}

export interface TabsProps<T extends string> {
  readonly tabs: readonly TabItem<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly className?: string | undefined;
  readonly label?: string;
}

export function Tabs<T extends string>({ tabs, value, onChange, className, label }: TabsProps<T>) {
  return (
    <div className={cx('k-tabs', className)} role="tablist" aria-label={label}>
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cx('k-tabs__tab', selected && 'is-selected')}
            onClick={() => onChange(t.value)}
          >
            {t.icon && <Icon name={t.icon} size={20} />}
            <span>{t.label}</span>
            {t.badge !== undefined && t.badge > 0 && <span className="k-badge">{t.badge}</span>}
            <span className="k-tabs__indicator" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
