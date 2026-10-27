/**
 * Root: provides the host, applies the M3 theme, loads settings, bridges host
 * events (settings / notices) into stores, wires Android/browser back
 * navigation, and renders the navigation shell.
 */
import { useEffect, useRef } from 'react';
import type { PlatformHost } from '@kotori/core';
import { SnackbarHost } from '../components/m3/Snackbar';
import { useAnimeStore } from '../features/anime/useAnimeStore';
import { useUpdateStore } from '../features/updater/updater';
import { HostProvider, useHost } from '../host/HostContext';
import { useHostEvents } from '../host/useHostEvents';
import { useT } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { showSnackbar } from '../stores/snackbar';
import { useTheme } from '../theme/useTheme';
import { dispatchBackNavigation, useRouteStore } from './routes';
import { Shell } from './Shell';

declare global {
  interface Window {
    __kotoriHandleBack?: () => boolean;
  }
}

function AppInner() {
  const host = useHost();
  const t = useT();
  useTheme();
  const load = useSettingsStore((s) => s.load);
  const receive = useSettingsStore((s) => s.receive);
  const lastExitPromptAtRef = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    load(host).catch((e: unknown) => showSnackbar(e instanceof Error ? e.message : String(e), { tone: 'error' }));
    if (host.info.platform !== 'mock' && !host.info.version.includes('mock') && !host.info.version.includes('test')) {
      void useUpdateStore.getState().checkForUpdate(host, { silent: true });
    }
  }, [host, load]);

  // Wire Android system back gesture / hardware back button (`window.__kotoriHandleBack`,
  // Capacitor `backbutton` document event) and browser `popstate`.
  useEffect(() => {
    const handleBack = (): boolean => {
      if (dispatchBackNavigation()) {
        lastExitPromptAtRef.current = 0;
        return true;
      }
      const now = Date.now();
      if (now - lastExitPromptAtRef.current < 2000) {
        lastExitPromptAtRef.current = 0;
        return false;
      }
      lastExitPromptAtRef.current = now;
      showSnackbar(tRef.current('common.pressBackAgainToExit'));
      return true;
    };

    window.__kotoriHandleBack = handleBack;

    const onDocBackButton = (e: Event): void => {
      e.preventDefault();
      handleBack();
    };
    const onPopState = (): void => {
      if (dispatchBackNavigation()) {
        lastExitPromptAtRef.current = 0;
        try {
          window.history.pushState({ kotori: true }, '');
        } catch {
          // Ignore in restricted environments
        }
      }
    };

    try {
      window.history.replaceState({ kotori: true }, '');
    } catch {
      // Ignore in restricted environments
    }

    const unsubRoute = useRouteStore.subscribe((state, prev) => {
      if (
        state.tab !== prev.tab ||
        state.anime !== prev.anime ||
        state.manga !== prev.manga ||
        state.downloadsTab !== prev.downloadsTab
      ) {
        lastExitPromptAtRef.current = 0;
        try {
          window.history.pushState({ kotori: true }, '');
        } catch {
          // Ignore
        }
      }
    });

    document.addEventListener('backbutton', onDocBackButton);
    window.addEventListener('popstate', onPopState);
    return () => {
      if (window.__kotoriHandleBack === handleBack) {
        delete window.__kotoriHandleBack;
      }
      unsubRoute();
      document.removeEventListener('backbutton', onDocBackButton);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

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
