/**
 * Navigation state (zustand): the active tab plus per-tab view params. No URL
 * router — the app runs in a desktop `--app` window or a Capacitor WebView.
 */
import { create } from 'zustand';
import type { Id } from '@kotori/core';

export type Tab = 'anime' | 'manga' | 'downloads' | 'settings';

export type AnimeView =
  | { readonly kind: 'library' }
  | { readonly kind: 'series'; readonly seriesId: Id }
  | { readonly kind: 'player'; readonly seriesId: Id; readonly episodeId: Id };

export type MangaView = { readonly kind: 'library' } | { readonly kind: 'reader'; readonly volumeId: Id };

export type DownloadsTab = 'tasks' | 'anime' | 'subtitles' | 'manga';

export interface RouteState {
  readonly tab: Tab;
  readonly anime: AnimeView;
  readonly manga: MangaView;
  readonly downloadsTab: DownloadsTab;
  setTab(tab: Tab): void;
  openAnime(view: AnimeView): void;
  openManga(view: MangaView): void;
  setDownloadsTab(tab: DownloadsTab): void;
  reset(): void;
}

const initial = {
  tab: 'anime' as Tab,
  anime: { kind: 'library' } as AnimeView,
  manga: { kind: 'library' } as MangaView,
  downloadsTab: 'tasks' as DownloadsTab,
};

export const useRouteStore = create<RouteState>()((set) => ({
  ...initial,
  setTab: (tab) => set({ tab }),
  openAnime: (anime) => set({ tab: 'anime', anime }),
  openManga: (manga) => set({ tab: 'manga', manga }),
  setDownloadsTab: (downloadsTab) => set({ tab: 'downloads', downloadsTab }),
  reset: () => set(initial),
}));
