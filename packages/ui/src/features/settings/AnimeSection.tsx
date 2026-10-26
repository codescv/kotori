/** Anime playback / transcript preferences and the Jimaku API key. */
import { Switch } from '../../components/m3/Switch';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { CommitTextField, NumberField, usePatchSettings } from './fields';

export function AnimeSection() {
  const t = useT();
  const anime = useSettingsStore((s) => s.settings.anime);
  const patch = usePatchSettings();
  return (
    <div className="k-stack">
      <Switch label={t('settings.anime.mergeKaraoke')} checked={anime.mergeKaraokeCues} onChange={(mergeKaraokeCues) => void patch({ anime: { mergeKaraokeCues } })} />
      <Switch label={t('settings.anime.hideSigns')} checked={anime.hideSigns} onChange={(hideSigns) => void patch({ anime: { hideSigns } })} />
      <Switch label={t('settings.anime.pauseAfterJump')} checked={anime.pauseAfterJump} onChange={(pauseAfterJump) => void patch({ anime: { pauseAfterJump } })} />
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
