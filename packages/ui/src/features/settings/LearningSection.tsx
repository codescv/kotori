/** Merged learning & manga reading defaults: furigana, romaji, pre-explain, reading mode, fit and background. */
import type { MangaReadingMode, MangaSettings } from '@kotori/core';
import { Chip } from '../../components/m3/Chip';
import { SegmentedButton } from '../../components/m3/SegmentedButton';
import { Switch } from '../../components/m3/Switch';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { usePatchSettings } from './fields';

type FuriganaMode = 'all' | 'tap' | 'off';

const MODES: readonly MangaReadingMode[] = ['spread-rtl', 'single-rtl', 'spread-ltr', 'single-ltr', 'webtoon'];

export function LearningSection() {
  const t = useT();
  const anime = useSettingsStore((s) => s.settings.anime);
  const manga = useSettingsStore((s) => s.settings.manga);
  const patch = usePatchSettings();
  const furiganaMode: FuriganaMode = anime.furiganaMode ?? 'all';

  return (
    <div className="k-stack">
      <div className="k-settings-inline" data-testid="settings-furigana-mode">
        <span className="k-label-large">{t('settings.anime.furiganaMode')}</span>
        <SegmentedButton<FuriganaMode>
          dense
          label={t('settings.anime.furiganaMode')}
          value={furiganaMode}
          onChange={(mode) => void patch({ anime: { furiganaMode: mode } })}
          segments={[
            { value: 'all', label: t('settings.anime.furigana.all') },
            { value: 'tap', label: t('settings.anime.furigana.tap') },
            { value: 'off', label: t('settings.anime.furigana.off') },
          ]}
        />
      </div>
      <Switch label={t('settings.anime.showRomaji')} checked={Boolean(anime.showRomaji)} onChange={(showRomaji) => void patch({ anime: { showRomaji } })} />
      <Switch
        label={t('settings.learning.animePreExplain')}
        checked={Boolean(anime.autoPreExplain)}
        onChange={(autoPreExplain) => void patch({ anime: { autoPreExplain } })}
      />
      <Switch
        label={t('settings.learning.mangaPreExplain')}
        checked={Boolean(manga.autoPreExplain)}
        onChange={(autoPreExplain) => void patch({ manga: { autoPreExplain } })}
      />
      <div className="k-settings-field">
        <span className="k-label-large">{t('settings.manga.defaultMode')}</span>
        <div className="k-row" role="radiogroup" aria-label={t('settings.manga.defaultMode')}>
          {MODES.map((m) => (
            <Chip
              key={m}
              kind="filter"
              role="radio"
              aria-checked={manga.defaultReadingMode === m}
              selected={manga.defaultReadingMode === m}
              onClick={() => void patch({ manga: { defaultReadingMode: m } })}
            >
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
    </div>
  );
}
