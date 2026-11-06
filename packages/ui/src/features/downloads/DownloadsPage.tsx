/**
 * Downloads: Tasks · Anime (Nyaa) · Subtitles (Jimaku) · Manga (mokuro.moe).
 * Owns the live subscription that keeps `useDownloadsStore` in sync and
 * supports horizontal swipe gestures across the four top tabs: the sub-tab pages live
 * in a `<TabPager>`, so dragging shows the adjacent sub-tab side by side.
 */
import { useEffect } from 'react';
import { useRouteStore, type DownloadsTab } from '../../app/routes';
import { CompactBrandButton } from '../../components/AssistantAvatar';
import { TabPager, useTabPager } from '../../components/m3/TabPager';
import { Tabs, useTabSwipe } from '../../components/m3/Tabs';
import { useIsInactiveTabSlide } from '../../components/m3/tabSlideContext';
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
const DOWNLOAD_TAB_ORDER: readonly DownloadsTab[] = ['tasks', 'anime', 'subtitles', 'manga'];

export interface DownloadsPageProps {
  /**
   * Sub-tab to show instead of the routed one while the Shell peeks this page during a
   * drag: the sub-tab the swipe would land on (`tasks` from Manga, `manga` from Settings).
   */
  readonly previewTab?: DownloadsTab | undefined;
}

function renderSubTab(tab: DownloadsTab) {
  switch (tab) {
    case 'tasks':
      return <DownloadList />;
    case 'anime':
      return <NyaaSearch />;
    case 'subtitles':
      return <JimakuSearch />;
    case 'manga':
      return <MokuroCatalogBrowser />;
  }
}

export function DownloadsPage({ previewTab }: DownloadsPageProps = {}) {
  const host = useHost();
  const t = useT();
  const routedTab = useRouteStore((s) => s.downloadsTab);
  const tab = previewTab ?? routedTab;
  // A peeked / exiting Downloads page is a still picture: no nested swiping or motion.
  const interactive = !useIsInactiveTabSlide();
  const setTab = useRouteStore((s) => s.setDownloadsTab);
  const load = useDownloadsStore((s) => s.load);
  const receive = useDownloadsStore((s) => s.receive);
  const activeCount = useDownloadsStore((s) => [...s.tasks.values()].filter((x) => ACTIVE.has(x.status)).length);
  const pager = useTabPager();
  // Nested inside the Shell swipe: at 'tasks' / 'manga' edges the gesture falls through to the Shell.
  // Only the sub-tab pages (not the header / tab bar) move.
  const swipeHandlers = useTabSwipe<DownloadsTab>(DOWNLOAD_TAB_ORDER, tab, (next) => setTab(next, { gesture: true }), {
    enabled: interactive,
    pager,
  });

  useEffect(() => {
    void load(host);
  }, [host, load]);
  useHostEvents(receive);

  return (
    <div className="k-page k-downloads" {...swipeHandlers}>
      <header className="k-page__header">
        <CompactBrandButton />
        <h1 className="k-headline-small">{t('downloads.title')}</h1>
      </header>
      <Tabs<DownloadsTab>
        label={t('downloads.title')}
        value={tab}
        onChange={(next) => setTab(next)}
        tabs={[
          { value: 'tasks', label: t('downloads.tab.tasks'), icon: 'download', badge: activeCount },
          { value: 'anime', label: t('downloads.tab.anime'), icon: 'movie' },
          { value: 'subtitles', label: t('downloads.tab.subtitles'), icon: 'subtitles' },
          { value: 'manga', label: t('downloads.tab.manga'), icon: 'book' },
        ]}
      />
      <TabPager<DownloadsTab>
        pager={pager}
        order={DOWNLOAD_TAB_ORDER}
        value={tab}
        enabled={interactive}
        className="k-downloads__body"
        slideClassName="k-downloads__slide"
        slideRole="tabpanel"
        data-testid="downloads-tabpanel"
        data-active-tab={tab}
        renderPage={renderSubTab}
      />
    </div>
  );
}
