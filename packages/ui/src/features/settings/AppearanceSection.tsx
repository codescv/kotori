/** Theme mode, M3 seed colour presets, UI locale, text scale and compact app icon selector — all applied live. */
import type { ThemeMode, UiSettings } from '@kotori/core';
import { SegmentedButton } from '../../components/m3/SegmentedButton';
import { Slider } from '../../components/m3/Slider';
import { cx } from '../../components/m3/cx';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { APP_ICON_PRESETS, resolveAppIcon } from '../../theme/app-icons';
import { DEFAULT_SEED_COLOR, normaliseSeed } from '../../theme/m3-theme';
import { usePatchSettings } from './fields';

export const SEED_PRESETS: readonly string[] = [DEFAULT_SEED_COLOR, '#7d8fc9', '#c98d7d', '#b48ab4', '#c9b37d', '#6fa8b8', '#d0849a', '#8f9a6b'];

export function AppearanceSection() {
  const t = useT();
  const ui = useSettingsStore((s) => s.settings.ui);
  const patch = usePatchSettings();
  const seed = normaliseSeed(ui.seedColor);
  const activeIcon = resolveAppIcon(ui.appIcon);

  return (
    <div className="k-stack">
      <div className="k-settings-field">
        <span className="k-label-large">{t('settings.appearance.theme')}</span>
        <SegmentedButton<ThemeMode>
          label={t('settings.appearance.theme')}
          value={ui.theme}
          onChange={(theme) => void patch({ ui: { theme } })}
          segments={[
            { value: 'system', label: t('settings.appearance.system') },
            { value: 'light', label: t('settings.appearance.light') },
            { value: 'dark', label: t('settings.appearance.dark') },
          ]}
        />
      </div>
      <div className="k-settings-field">
        <span className="k-label-large">{t('settings.appearance.seed')}</span>
        <div className="k-seed-swatches" role="radiogroup" aria-label={t('settings.appearance.seed')}>
          {SEED_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === seed}
              aria-label={c}
              title={c}
              className={cx('k-seed-swatch', c === seed && 'is-selected')}
              style={{ background: c }}
              onClick={() => void patch({ ui: { seedColor: c } })}
            />
          ))}
        </div>
      </div>
      <div className="k-settings-field">
        <span className="k-label-large">{t('settings.appearance.locale')}</span>
        <SegmentedButton<UiSettings['locale']>
          label={t('settings.appearance.locale')}
          value={ui.locale}
          onChange={(locale) => void patch({ ui: { locale } })}
          segments={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en', label: 'English' },
            { value: 'ja', label: '日本語' },
          ]}
        />
      </div>
      <div className="k-settings-field">
        <Slider
          label={t('settings.appearance.fontScale')}
          value={ui.fontScale}
          min={0.8}
          max={1.6}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(fontScale) => void patch({ ui: { fontScale } })}
        />
        <p className="k-font-preview" lang="ja">
          <ruby>
            食<rt>た</rt>
          </ruby>
          べてんじゃねぇよ！
        </p>
      </div>
      <div className="k-settings-field" data-testid="settings-app-icon">
        <span className="k-label-large">{t('settings.appearance.appIcon')}</span>
        <div className="k-app-icon-grid" role="radiogroup" aria-label={t('settings.appearance.appIcon')}>
          {APP_ICON_PRESETS.map((preset) => {
            const selected = preset.id === activeIcon;
            const label = t(preset.labelKey);
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                title={label}
                data-testid={`app-icon-${preset.id}`}
                className={cx('k-app-icon-option', selected && 'is-selected')}
                onClick={() => void patch({ ui: { appIcon: preset.id } })}
              >
                <img src={preset.src} alt={label} className="k-app-icon-option__img" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
