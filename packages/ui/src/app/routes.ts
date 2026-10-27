/**
 * Navigation state (zustand): the active tab, per-tab view params, route
 * history stack, and LIFO back-navigation interceptors for Android system
 * back gestures / hardware back button and browser history `popstate`.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { Id } from '@kotori/core';
import { useBreakdownStore } from '../stores/breakdown';

export type Tab = 'anime' | 'manga' | 'downloads' | 'settings';

export type AnimeView =
  | { readonly kind: 'library' }
  | { readonly kind: 'series'; readonly seriesId: Id }
  | { readonly kind: 'player'; readonly seriesId: Id; readonly episodeId: Id };

export type MangaView = { readonly kind: 'library' } | { readonly kind: 'reader'; readonly volumeId: Id };

export type DownloadsTab = 'tasks' | 'anime' | 'subtitles' | 'manga';

export interface RouteSnapshot {
  readonly tab: Tab;
  readonly anime: AnimeView;
  readonly manga: MangaView;
  readonly downloadsTab: DownloadsTab;
}

export interface RouteState extends RouteSnapshot {
  readonly personaOpen: boolean;
  readonly readerImmersive: boolean;
  readonly history: readonly RouteSnapshot[];
  setTab(tab: Tab): void;
  openAnime(view: AnimeView): void;
  openManga(view: MangaView): void;
  setDownloadsTab(tab: DownloadsTab): void;
  setPersonaOpen(open: boolean): void;
  setReaderImmersive(immersive: boolean): void;
  toggleReaderImmersive(): void;
  /** Unwinds one navigation level; returns `true` if handled or `false` if already at root. */
  goBack(): boolean;
  reset(): void;
}

const MAX_HISTORY = 40;

const snapshotOf = (s: RouteSnapshot): RouteSnapshot => ({
  tab: s.tab,
  anime: s.anime,
  manga: s.manga,
  downloadsTab: s.downloadsTab,
});

const sameAnimeView = (a: AnimeView, b: AnimeView): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'series' && b.kind === 'series') return a.seriesId === b.seriesId;
  if (a.kind === 'player' && b.kind === 'player') return a.seriesId === b.seriesId && a.episodeId === b.episodeId;
  return true;
};

const sameMangaView = (a: MangaView, b: MangaView): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'reader' && b.kind === 'reader') return a.volumeId === b.volumeId;
  return true;
};

export const sameSnapshot = (a: RouteSnapshot, b: RouteSnapshot): boolean =>
  a.tab === b.tab &&
  a.downloadsTab === b.downloadsTab &&
  sameAnimeView(a.anime, b.anime) &&
  sameMangaView(a.manga, b.manga);

const pushSnapshot = (history: readonly RouteSnapshot[], prev: RouteSnapshot, next: RouteSnapshot): readonly RouteSnapshot[] => {
  if (sameSnapshot(prev, next)) return history;
  const last = history[history.length - 1];
  const base = last && sameSnapshot(last, prev) ? history : [...history, snapshotOf(prev)];
  return base.length > MAX_HISTORY ? base.slice(base.length - MAX_HISTORY) : base;
};

const initial = {
  tab: 'anime' as Tab,
  anime: { kind: 'library' } as AnimeView,
  manga: { kind: 'library' } as MangaView,
  downloadsTab: 'tasks' as DownloadsTab,
  personaOpen: false,
  readerImmersive: false,
  history: [] as readonly RouteSnapshot[],
};

export type BackInterceptor = () => boolean;

const backInterceptors: BackInterceptor[] = [];

/** Registers a LIFO back-button interceptor; returns an unregister callback. */
export function registerBackInterceptor(fn: BackInterceptor): () => void {
  backInterceptors.push(fn);
  return () => {
    const idx = backInterceptors.lastIndexOf(fn);
    if (idx >= 0) backInterceptors.splice(idx, 1);
  };
}

/** React hook that registers a component-level back interceptor while mounted and `enabled`. */
export function useBackInterceptor(fn: BackInterceptor, enabled = true): void {
  const fnRef = useRef<BackInterceptor>(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return registerBackInterceptor(() => fnRef.current());
  }, [enabled]);
}

/**
 * Dispatches a system/browser back navigation across fullscreen, dialogs,
 * active component interceptors (LIFO), and `useRouteStore.getState().goBack()`.
 * Returns `true` if a layer consumed the back action, or `false` if already at root.
 */
export function dispatchBackNavigation(): boolean {
  if (typeof document !== 'undefined' && document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => {});
    return true;
  }

  if (useRouteStore.getState().personaOpen) {
    useRouteStore.getState().setPersonaOpen(false);
    return true;
  }

  for (let i = backInterceptors.length - 1; i >= 0; i--) {
    const interceptor = backInterceptors[i];
    if (interceptor && interceptor()) {
      return true;
    }
  }

  return useRouteStore.getState().goBack();
}

export const useRouteStore = create<RouteState>()((set, get) => ({
  ...initial,
  setTab: (tab) =>
    set((s) => {
      const next: RouteSnapshot = { tab, anime: s.anime, manga: s.manga, downloadsTab: s.downloadsTab };
      return {
        tab,
        readerImmersive: tab === 'manga' && s.manga.kind === 'reader' ? s.readerImmersive : false,
        history: pushSnapshot(s.history, s, next),
      };
    }),
  openAnime: (anime) =>
    set((s) => {
      const next: RouteSnapshot = { tab: 'anime', anime, manga: s.manga, downloadsTab: s.downloadsTab };
      return {
        tab: 'anime',
        anime,
        readerImmersive: false,
        history: pushSnapshot(s.history, s, next),
      };
    }),
  openManga: (manga) =>
    set((s) => {
      const next: RouteSnapshot = { tab: 'manga', anime: s.anime, manga, downloadsTab: s.downloadsTab };
      return {
        tab: 'manga',
        manga,
        readerImmersive: false,
        history: pushSnapshot(s.history, s, next),
      };
    }),
  setDownloadsTab: (downloadsTab) =>
    set((s) => {
      const next: RouteSnapshot = { tab: 'downloads', anime: s.anime, manga: s.manga, downloadsTab };
      return {
        tab: 'downloads',
        downloadsTab,
        readerImmersive: false,
        history: pushSnapshot(s.history, s, next),
      };
    }),
  setPersonaOpen: (personaOpen) => set({ personaOpen }),
  setReaderImmersive: (readerImmersive) => set({ readerImmersive }),
  toggleReaderImmersive: () => set((s) => ({ readerImmersive: !s.readerImmersive })),
  goBack: () => {
    const s = get();
    if (s.personaOpen) {
      set({ personaOpen: false });
      return true;
    }
    if (useBreakdownStore.getState().isOpen) {
      useBreakdownStore.getState().close();
      return true;
    }
    if (s.tab === 'anime' && s.anime.kind === 'player') {
      const target: AnimeView = { kind: 'series', seriesId: s.anime.seriesId };
      const top = s.history[s.history.length - 1];
      const nextHistory =
        top && top.tab === 'anime' && sameAnimeView(top.anime, target) ? s.history.slice(0, -1) : s.history;
      set({ anime: target, history: nextHistory });
      return true;
    }
    if (s.tab === 'anime' && s.anime.kind === 'series') {
      const target: AnimeView = { kind: 'library' };
      const top = s.history[s.history.length - 1];
      const nextHistory =
        top && top.tab === 'anime' && sameAnimeView(top.anime, target) ? s.history.slice(0, -1) : s.history;
      set({ anime: target, history: nextHistory });
      return true;
    }
    if (s.tab === 'manga' && s.manga.kind === 'reader') {
      const target: MangaView = { kind: 'library' };
      const top = s.history[s.history.length - 1];
      const nextHistory =
        top && top.tab === 'manga' && sameMangaView(top.manga, target) ? s.history.slice(0, -1) : s.history;
      set({ manga: target, readerImmersive: false, history: nextHistory });
      return true;
    }
    if (s.history.length > 0) {
      const prev = s.history[s.history.length - 1]!;
      set({
        tab: prev.tab,
        anime: prev.anime,
        manga: prev.manga,
        downloadsTab: prev.downloadsTab,
        readerImmersive: false,
        history: s.history.slice(0, -1),
      });
      return true;
    }
    if (s.tab === 'downloads' && s.downloadsTab !== 'tasks') {
      set({ downloadsTab: 'tasks' });
      return true;
    }
    if (s.tab !== 'anime') {
      set({ tab: 'anime', readerImmersive: false });
      return true;
    }
    return false;
  },
  reset: () => {
    set(initial);
  },
}));
