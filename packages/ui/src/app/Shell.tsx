/**
 * Navigation shell: M3 navigation rail on expanded windows (≥ 840 px) and a
 * bottom navigation bar on phones, with the four tabs
 * 🎬 Anime · 📖 Manga · ⬇️ Downloads · ⚙️ Settings.
 */
import { useEffect, useState } from 'react';
import type { DownloadTask } from '@kotori/core';
import { AssistantAvatar, PersonaDialog } from '../components/AssistantAvatar';
import { cx } from '../components/m3/cx';
import { Icon, type IconName } from '../components/m3/Icon';
import { useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { useIsExpanded } from '../hooks/useMediaQuery';
import { useT, type MessageKey } from '../i18n';
import { AnimePage } from '../features/anime/AnimePage';
import { DownloadsPage } from '../features/downloads/DownloadsPage';
import { MangaPage } from '../features/manga/MangaPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { useRouteStore, type Tab } from './routes';

const TABS: readonly { readonly tab: Tab; readonly icon: IconName; readonly label: MessageKey }[] = [
  { tab: 'anime', icon: 'movie', label: 'nav.anime' },
  { tab: 'manga', icon: 'book', label: 'nav.manga' },
  { tab: 'downloads', icon: 'download', label: 'nav.downloads' },
  { tab: 'settings', icon: 'settings', label: 'nav.settings' },
];

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
  const expanded = useIsExpanded();
  const activeDownloads = useActiveDownloads();
  const [personaOpen, setPersonaOpen] = useState(false);
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
      <main className="k-shell__content" data-tab={tab}>
        {tab === 'anime' && <AnimePage />}
        {tab === 'manga' && <MangaPage />}
        {tab === 'downloads' && <DownloadsPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
      {!expanded && nav}
      <PersonaDialog open={personaOpen} onClose={() => setPersonaOpen(false)} />
    </div>
  );
}
