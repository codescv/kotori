/**
 * Anime library store: series list + episodes per series, cached and
 * invalidated by `library-changed` (scope `anime`) host events.
 */
import { create } from 'zustand';
import type { AnimeEpisode, AnimeSeries, Id, PlatformHost } from '@kotori/core';

export interface AnimeState {
  readonly series: readonly AnimeSeries[] | undefined;
  readonly episodes: Readonly<Record<Id, readonly AnimeEpisode[]>>;
  readonly loading: boolean;
  readonly error: string | undefined;
  loadSeries(host: PlatformHost): Promise<void>;
  loadEpisodes(host: PlatformHost, seriesId: Id): Promise<void>;
  /** Drop caches and reload what is currently displayed. */
  invalidate(host: PlatformHost): Promise<void>;
  reset(): void;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useAnimeStore = create<AnimeState>()((set, get) => ({
  series: undefined,
  episodes: {},
  loading: false,
  error: undefined,
  async loadSeries(host) {
    set({ loading: true, error: undefined });
    try {
      const series = await host.anime.listSeries();
      set({ series, loading: false });
    } catch (e) {
      set({ loading: false, error: msg(e) });
    }
  },
  async loadEpisodes(host, seriesId) {
    try {
      const list = await host.anime.listEpisodes(seriesId);
      set((s) => ({ episodes: { ...s.episodes, [seriesId]: list } }));
    } catch (e) {
      set({ error: msg(e) });
    }
  },
  async invalidate(host) {
    const loaded = Object.keys(get().episodes);
    set({ episodes: {} });
    await Promise.all([get().loadSeries(host), ...loaded.map((id) => get().loadEpisodes(host, id))]);
  },
  reset() {
    set({ series: undefined, episodes: {}, loading: false, error: undefined });
  },
}));
