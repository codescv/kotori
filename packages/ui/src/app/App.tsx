/**
 * Root: provides the host, applies the M3 theme, loads settings, bridges host
 * events (settings / notices) into stores, and renders the navigation shell.
 */
import { useEffect } from 'react';
import type { PlatformHost } from '@kotori/core';
import { SnackbarHost } from '../components/m3/Snackbar';
import { useAnimeStore } from '../features/anime/useAnimeStore';
import { useUpdateStore } from '../features/updater/updater';
import { HostProvider, useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { useSettingsStore } from '../stores/settings';
import { showSnackbar } from '../stores/snackbar';
import { useTheme } from '../theme/useTheme';
import { Shell } from './Shell';

function AppInner() {
  const host = useHost();
  useTheme();
  const load = useSettingsStore((s) => s.load);
  const receive = useSettingsStore((s) => s.receive);
  useEffect(() => {
    load(host).catch((e: unknown) => showSnackbar(e instanceof Error ? e.message : String(e), { tone: 'error' }));
    if (host.info.platform !== 'mock' && !host.info.version.includes('mock') && !host.info.version.includes('test')) {
      void useUpdateStore.getState().checkForUpdate(host, { silent: true });
    }
  }, [host, load]);
  useHostEvents((e) => {
    if (e.type === 'settings-changed') receive(e.settings);
    else if (e.type === 'host-notice') showSnackbar(e.message, { tone: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : 'info' });
    else if (e.type === 'library-changed' && e.scope === 'anime') void useAnimeStore.getState().invalidate(host);
    else if (
      e.type === 'download-updated' &&
      e.task.status === 'completed' &&
      (e.task.kind === 'torrent' || e.task.kind === 'jimaku-subtitle' || Boolean(e.task.importedSeriesId) || Boolean(e.task.importedTrackId))
    ) {
      void useAnimeStore.getState().invalidate(host);
    }
  });
  return (
    <>
      <Shell />
      <SnackbarHost />
    </>
  );
}

export function App({ host }: { readonly host: PlatformHost }) {
  return (
    <HostProvider host={host}>
      <AppInner />
    </HostProvider>
  );
}
