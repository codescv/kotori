/**
 * Downloads: Tasks · Anime (Nyaa) · Subtitles (Jimaku) · Manga (mokuro.moe).
 * Owns the live subscription that keeps `useDownloadsStore` in sync.
 */
import { useEffect } from 'react';
import { useRouteStore, type DownloadsTab } from '../../app/routes';
import { CompactBrandButton } from '../../components/AssistantAvatar';
import { Tabs } from '../../components/m3/Tabs';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { DownloadList } from './DownloadList';
import { JimakuSearch } from './JimakuSearch';
import { MokuroCatalogBrowser } from './MokuroCatalogBrowser';
import { NyaaSearch } from './NyaaSearch';
import { useDownloadsStore } from './useDownloadsStore';
import './downloads.css';

const ACTIVE = new Set(['queued', 'resolving', 'downloading', 'importing']);

export function DownloadsPage() {
  const host = useHost();
  const t = useT();
  const tab = useRouteStore((s) => s.downloadsTab);
  const setTab = useRouteStore((s) => s.setDownloadsTab);
  const load = useDownloadsStore((s) => s.load);
  const receive = useDownloadsStore((s) => s.receive);
  const activeCount = useDownloadsStore((s) => [...s.tasks.values()].filter((x) => ACTIVE.has(x.status)).length);

  useEffect(() => {
    void load(host);
  }, [host, load]);
  useHostEvents(receive);

  return (
    <div className="k-page k-downloads">
      <header className="k-page__header">
        <CompactBrandButton />
        <h1 className="k-headline-small">{t('downloads.title')}</h1>
      </header>
      <Tabs<DownloadsTab>
        label={t('downloads.title')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'tasks', label: t('downloads.tab.tasks'), icon: 'download', badge: activeCount },
          { value: 'anime', label: t('downloads.tab.anime'), icon: 'movie' },
          { value: 'subtitles', label: t('downloads.tab.subtitles'), icon: 'subtitles' },
          { value: 'manga', label: t('downloads.tab.manga'), icon: 'book' },
        ]}
      />
      <div className="k-downloads__body" role="tabpanel">
        {tab === 'tasks' && <DownloadList />}
        {tab === 'anime' && <NyaaSearch />}
        {tab === 'subtitles' && <JimakuSearch />}
        {tab === 'manga' && <MokuroCatalogBrowser />}
      </div>
    </div>
  );
}
