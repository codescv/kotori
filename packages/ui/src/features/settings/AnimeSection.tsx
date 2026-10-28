/** Anime playback / transcript preferences, learning display options and the Jimaku API key. */
import { SegmentedButton } from '../../components/m3/SegmentedButton';
import { Switch } from '../../components/m3/Switch';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { CommitTextField, NumberField, usePatchSettings } from './fields';

type FuriganaMode = 'all' | 'tap' | 'off';

export function AnimeSection() {
  const t = useT();
  const anime = useSettingsStore((s) => s.settings.anime);
  const patch = usePatchSettings();
  const furiganaMode: FuriganaMode = anime.furiganaMode ?? 'all';
  return (
    <div className="k-stack">
      <Switch label={t('settings.anime.mergeKaraoke')} checked={anime.mergeKaraokeCues} onChange={(mergeKaraokeCues) => void patch({ anime: { mergeKaraokeCues } })} />
      <Switch label={t('settings.anime.hideSigns')} checked={anime.hideSigns} onChange={(hideSigns) => void patch({ anime: { hideSigns } })} />
      <Switch label={t('settings.anime.pauseAfterJump')} checked={anime.pauseAfterJump} onChange={(pauseAfterJump) => void patch({ anime: { pauseAfterJump } })} />
      <Switch
        label={t('settings.anime.pauseOnTranscriptClick')}
        checked={anime.pauseOnTranscriptClick !== false}
        onChange={(pauseOnTranscriptClick) => void patch({ anime: { pauseOnTranscriptClick } })}
      />
      <Switch label={t('settings.anime.autoPreExplain')} checked={Boolean(anime.autoPreExplain)} onChange={(autoPreExplain) => void patch({ anime: { autoPreExplain } })} />
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
      <div className="k-settings-grid">
        <NumberField label={t('settings.anime.repeatCount')} value={anime.repeatCount} min={0} max={99} onCommit={(v) => void patch({ anime: { repeatCount: v ?? 0 } })} />
        <NumberField label={t('settings.anime.seekPadding')} value={anime.seekPaddingMs} min={0} max={5000} step={50} onCommit={(v) => void patch({ anime: { seekPaddingMs: v ?? 0 } })} />
      </div>
      <Switch label={t('settings.anime.autoJimaku')} checked={anime.autoDownloadJimaku} onChange={(autoDownloadJimaku) => void patch({ anime: { autoDownloadJimaku } })} />
      <CommitTextField label={t('settings.anime.jimakuKey')} type="password" value={anime.jimakuApiKey} supportingText={t('settings.anime.jimakuKeyHelp')} onCommit={(jimakuApiKey) => void patch({ anime: { jimakuApiKey: jimakuApiKey.trim() } })} />
      <CommitTextField
        label={t('settings.anime.languages')}
        value={anime.preferredSubtitleLanguages.join(', ')}
        onCommit={(v) =>
          void patch({
            anime: {
              preferredSubtitleLanguages: v
                .split(/[,，\s]+/)
                .map((x) => x.trim().toLowerCase())
                .filter(Boolean),
            },
          })
        }
      />
    </div>
  );
}
