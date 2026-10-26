/** Download directory, concurrency, torrent limits and source mirrors. */
import { Switch } from '../../components/m3/Switch';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { CommitTextField, NumberField, usePatchSettings } from './fields';

const isHttpUrl = (v: string): boolean => /^https?:\/\/\S+$/i.test(v.trim());

export function DownloadsSection() {
  const t = useT();
  const host = useHost();
  const torrent = host.info.capabilities.torrent;
  const dl = useSettingsStore((s) => s.settings.downloads);
  const patch = usePatchSettings();
  const kib = (bps: number | undefined): number => (bps === undefined ? 0 : Math.round(bps / 1024));
  return (
    <div className="k-stack">
      <CommitTextField label={t('settings.downloads.dir')} value={dl.downloadDir} onCommit={(downloadDir) => void patch({ downloads: { downloadDir: downloadDir.trim() } })} validate={(v) => (v.trim() ? undefined : t('settings.ai.required'))} />
      <div className="k-settings-grid">
        <NumberField label={t('settings.downloads.maxActive')} value={dl.maxActiveDownloads} min={1} max={10} onCommit={(v) => void patch({ downloads: { maxActiveDownloads: v ?? 1 } })} />
        {torrent && <NumberField label={t('settings.downloads.maxPeers')} value={dl.maxPeersPerTorrent} min={1} max={500} onCommit={(v) => void patch({ downloads: { maxPeersPerTorrent: v ?? 50 } })} />}
      </div>
      {torrent && (
        <>
          <div className="k-settings-grid">
            <NumberField label={t('settings.downloads.downloadLimit')} value={kib(dl.downloadLimitBps)} min={0} onCommit={(v) => void patch({ downloads: { downloadLimitBps: (v ?? 0) * 1024 } })} />
            <NumberField label={t('settings.downloads.uploadLimit')} value={kib(dl.uploadLimitBps)} min={0} onCommit={(v) => void patch({ downloads: { uploadLimitBps: (v ?? 0) * 1024 } })} />
          </div>
          <Switch label={t('settings.downloads.seed')} checked={dl.seedAfterComplete} onChange={(seedAfterComplete) => void patch({ downloads: { seedAfterComplete } })} />
          <CommitTextField label={t('settings.downloads.nyaa')} type="url" value={dl.nyaaBaseUrl} validate={(v) => (isHttpUrl(v) ? undefined : t('settings.invalidUrl'))} onCommit={(nyaaBaseUrl) => void patch({ downloads: { nyaaBaseUrl: nyaaBaseUrl.trim() } })} />
        </>
      )}
      <CommitTextField label={t('settings.downloads.mokuro')} type="url" value={dl.mokuroCatalogUrl} validate={(v) => (isHttpUrl(v) ? undefined : t('settings.invalidUrl'))} onCommit={(mokuroCatalogUrl) => void patch({ downloads: { mokuroCatalogUrl: mokuroCatalogUrl.trim() } })} />
    </div>
  );
}
