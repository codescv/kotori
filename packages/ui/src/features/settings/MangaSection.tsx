/** Manga reader defaults: reading mode, fit, background, outlines, preloading. */
import type { MangaReadingMode, MangaSettings } from '@kotori/core';
import { Chip } from '../../components/m3/Chip';
import { SegmentedButton } from '../../components/m3/SegmentedButton';
import { Slider } from '../../components/m3/Slider';
import { Switch } from '../../components/m3/Switch';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { usePatchSettings } from './fields';

const MODES: readonly MangaReadingMode[] = ['spread-rtl', 'single-rtl', 'spread-ltr', 'single-ltr', 'webtoon'];

export function MangaSection() {
  const t = useT();
  const manga = useSettingsStore((s) => s.settings.manga);
  const patch = usePatchSettings();
  return (
    <div className="k-stack">
      <div className="k-settings-field">
        <span className="k-label-large">{t('settings.manga.defaultMode')}</span>
        <div className="k-row" role="radiogroup" aria-label={t('settings.manga.defaultMode')}>
          {MODES.map((m) => (
            <Chip key={m} kind="filter" role="radio" aria-checked={manga.defaultReadingMode === m} selected={manga.defaultReadingMode === m} onClick={() => void patch({ manga: { defaultReadingMode: m } })}>
              {t(`manga.mode.${m}`)}
            </Chip>
          ))}
        </div>
      </div>
      <div className="k-settings-field">
        <span className="k-label-large">{t('settings.manga.fit')}</span>
        <SegmentedButton<MangaSettings['fit']>
          dense
          label={t('settings.manga.fit')}
          value={manga.fit}
          onChange={(fit) => void patch({ manga: { fit } })}
          segments={(['contain', 'width', 'height'] as const).map((v) => ({ value: v, label: t(`settings.manga.fit.${v}`) }))}
        />
      </div>
      <div className="k-settings-field">
        <span className="k-label-large">{t('settings.manga.background')}</span>
        <SegmentedButton<MangaSettings['background']>
          dense
          label={t('settings.manga.background')}
          value={manga.background}
          onChange={(background) => void patch({ manga: { background } })}
          segments={(['surface', 'black', 'white'] as const).map((v) => ({ value: v, label: t(`settings.manga.background.${v}`) }))}
        />
      </div>
      <Switch label={t('settings.manga.outlines')} checked={manga.showBlockOutlines} onChange={(showBlockOutlines) => void patch({ manga: { showBlockOutlines } })} />
      <Slider label={t('settings.manga.preload')} value={manga.preloadPages} min={0} max={8} step={1} onChange={(preloadPages) => void patch({ manga: { preloadPages } })} />
    </div>
  );
}
