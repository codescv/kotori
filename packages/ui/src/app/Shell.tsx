/**
 * Navigation shell: M3 navigation rail on expanded windows (≥ 840 × 500 px) and a
 * bottom navigation bar on phones (hidden inside the player and the manga reader),
 * with the four tabs
 * 🎬 Anime · 📖 Manga · ⬇️ Downloads · ⚙️ Settings.
 * Horizontal swipes on the content area switch tabs (except inside the player and
 * the manga reader, whose horizontal gestures are page turns / scrubbing), chaining
 * through the Downloads sub-tabs like nested Android ViewPager2 pages. The pages live
 * in a `<TabPager>`: dragging reveals the adjacent destination side by side with the
 * current one, releasing glides them on (or back), and nav taps slide the old and new
 * destination side by side. At rest — and always inside the player / reader — only
 * the active page is mounted and no ancestor of it carries a transform (it would trap
 * the immersive player's `position: fixed`).
 */
import { useEffect, useState } from 'react';
import type { DownloadTask } from '@kotori/core';
import { AssistantAvatar, PersonaDialog } from '../components/AssistantAvatar';
import { cx } from '../components/m3/cx';
import { Icon, type IconName } from '../components/m3/Icon';
import { TabPager, useTabPager, type TabPagerSlide } from '../components/m3/TabPager';
import { useTabSwipe, type TabSwipeDirection } from '../components/m3/Tabs';
import { useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { useIsExpanded, useIsMobileLandscape } from '../hooks/useMediaQuery';
import { useT, type MessageKey } from '../i18n';
import { AnimePage } from '../features/anime/AnimePage';
import { DownloadsPage } from '../features/downloads/DownloadsPage';
import { MangaPage } from '../features/manga/MangaPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { UpdateBanner } from '../features/updater/UpdateBanner';
import { useRouteStore, type DownloadsTab, type Tab } from './routes';

const TABS: readonly { readonly tab: Tab; readonly icon: IconName; readonly label: MessageKey }[] = [
  { tab: 'anime', icon: 'movie', label: 'nav.anime' },
  { tab: 'manga', icon: 'book', label: 'nav.manga' },
  { tab: 'downloads', icon: 'download', label: 'nav.downloads' },
  { tab: 'settings', icon: 'settings', label: 'nav.settings' },
];

/** Swipe order of the top-level destinations (swipe left = next). */
const SHELL_TAB_ORDER: readonly Tab[] = TABS.map((d) => d.tab);

/**
 * Downloads sub-tab to land on when a swipe enters Downloads: swiping left (from
 * Manga) enters its first sub-tab, swiping right (from Settings) its last one, so
 * the sub-tabs read as one continuous strip in both directions.
 */
const DOWNLOADS_ENTRY: Readonly<Record<TabSwipeDirection, DownloadsTab>> = { next: 'tasks', prev: 'manga' };

const ACTIVE: ReadonlySet<DownloadTask['status']> = new Set(['queued', 'resolving', 'downloading', 'importing']);

/** Number of active downloads (badge on the Downloads destination). */
function useActiveDownloads(): number {
  const host = useHost();
  const [active, setActive] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    let alive = true;
    host.downloads
      .list()
      .then((list) => alive && setActive(new Map(list.map((t) => [t.id, ACTIVE.has(t.status)]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [host]);
  useHostEvents((e) => {
    if (e.type === 'download-updated') setActive((m) => new Map(m).set(e.task.id, ACTIVE.has(e.task.status)));
    else if (e.type === 'download-removed')
      setActive((m) => {
        const n = new Map(m);
        n.delete(e.taskId);
        return n;
      });
  });
  return [...active.values()].filter(Boolean).length;
}

export function Shell() {
  const t = useT();
  const tab = useRouteStore((s) => s.tab);
  const setTab = useRouteStore((s) => s.setTab);
  const mangaView = useRouteStore((s) => s.manga);
  const animeView = useRouteStore((s) => s.anime);
  const readerImmersive = useRouteStore((s) => s.readerImmersive);
  const personaOpen = useRouteStore((s) => s.personaOpen);
  const setPersonaOpen = useRouteStore((s) => s.setPersonaOpen);
  const expanded = useIsExpanded();
  const mobileLandscape = useIsMobileLandscape();
  const activeDownloads = useActiveDownloads();
  const inReader = tab === 'manga' && mangaView.kind === 'reader';
  const inPlayer = tab === 'anime' && animeView.kind === 'player';
  const hideCompactChrome = !expanded && ((inReader && readerImmersive) || (inPlayer && mobileLandscape));
  // Immersive player / reader on phones: the bottom NavBar would eat ~17% of the
  // viewport height, and both views have their own back button.
  const hideCompactNav = !expanded && (inReader || inPlayer);
  const pager = useTabPager();
  const swipeEnabled = !inPlayer && !inReader;
  const swipeHandlers = useTabSwipe<Tab>(
    SHELL_TAB_ORDER,
    tab,
    (next, direction) =>
      setTab(next, next === 'downloads' ? { downloadsTab: DOWNLOADS_ENTRY[direction], gesture: true } : { gesture: true }),
    // Horizontal gestures inside the player / reader belong to them (scrub, page turn, zoom-pan);
    // disabling also drops any drag / slide (and the second page) at once.
    { enabled: swipeEnabled, pager },
  );
  /** The player / reader never mount as a peeked page (playback, wake lock, fullscreen…). */
  const peekable = (t: Tab): boolean =>
    !(t === 'anime' && animeView.kind === 'player') && !(t === 'manga' && mangaView.kind === 'reader');
  const renderPage = (t: Tab, slide: TabPagerSlide) => {
    switch (t) {
      case 'anime':
        return <AnimePage />;
      case 'manga':
        return <MangaPage />;
      case 'downloads':
        // A peeked Downloads shows the sub-tab a swipe from that side lands on.
        return <DownloadsPage previewTab={slide.role === 'neighbor' && slide.side ? DOWNLOADS_ENTRY[slide.side] : undefined} />;
      case 'settings':
        return <SettingsPage />;
    }
  };
  const nav = (
    <nav className={expanded ? 'k-nav-rail' : 'k-nav-bar'} aria-label={t('app.name')}>
      {expanded && (
        <div className="k-nav-rail__brand">
          <button
            type="button"
            className="k-nav-rail__brand-btn"
            aria-label={t('persona.title')}
            title={t('persona.title')}
            onClick={() => setPersonaOpen(true)}
            data-testid="brand-persona-trigger"
          >
            <AssistantAvatar />
          </button>
        </div>
      )}
      {TABS.map((d) => (
        <button
          key={d.tab}
          type="button"
          className={cx('k-nav-item', tab === d.tab && 'is-active')}
          aria-current={tab === d.tab ? 'page' : undefined}
          onClick={() => setTab(d.tab)}
        >
          <span className="k-nav-item__indicator">
            <Icon name={d.icon} />
            {d.tab === 'downloads' && activeDownloads > 0 && <span className="k-badge k-badge--nav">{activeDownloads}</span>}
          </span>
          <span className="k-nav-item__label">{t(d.label)}</span>
        </button>
      ))}
    </nav>
  );
  return (
    <div className={cx('k-shell', expanded ? 'k-shell--expanded' : 'k-shell--compact')} data-kotori-shell>
      {expanded && nav}
      <main className="k-shell__content" data-tab={tab} {...swipeHandlers}>
        {!hideCompactChrome && <UpdateBanner />}
        <TabPager<Tab>
          pager={pager}
          order={SHELL_TAB_ORDER}
          value={tab}
          enabled={swipeEnabled}
          peekable={peekable}
          className="k-shell__pager"
          renderPage={renderPage}
        />
      </main>
      {!expanded && !hideCompactNav && nav}
      <PersonaDialog open={personaOpen} onClose={() => setPersonaOpen(false)} />
    </div>
  );
}
