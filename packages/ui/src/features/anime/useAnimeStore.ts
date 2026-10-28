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
  /** Immediately evict a removed series from cached `series` and `episodes` without firing 404 requests. */
  forgetSeries(seriesId: Id): void;
  /** Drop caches and reload what is currently displayed. */
  invalidate(host: PlatformHost): Promise<void>;
  reset(): void;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isNotFoundError = (e: unknown): boolean =>
  (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'not-found') ||
  /\bnot[- ]found\b/i.test(msg(e));

export const useAnimeStore = create<AnimeState>()((set, get) => ({
  series: undefined,
  episodes: {},
  loading: false,
  error: undefined,
  async loadSeries(host) {
    set({ loading: true, error: undefined });
    try {
      const series = await host.anime.listSeries();
      set({ series, loading: false, error: undefined });
    } catch (e) {
      set({ loading: false, error: msg(e) });
    }
  },
  async loadEpisodes(host, seriesId) {
    try {
      const list = await host.anime.listEpisodes(seriesId);
      set((s) => ({ episodes: { ...s.episodes, [seriesId]: list } }));
    } catch (e) {
      if (isNotFoundError(e)) {
        set((s) => {
          const { [seriesId]: _removed, ...rest } = s.episodes;
          return { episodes: rest };
        });
        return;
      }
      set({ error: msg(e) });
    }
  },
  forgetSeries(seriesId) {
    set((s) => {
      const { [seriesId]: _removed, ...restEpisodes } = s.episodes;
      return {
        episodes: restEpisodes,
        series: s.series ? s.series.filter((item) => item.id !== seriesId) : s.series,
        error: undefined,
      };
    });
  },
  async invalidate(host) {
    const loaded = Object.keys(get().episodes);
    await get().loadSeries(host);
    const validIds = new Set((get().series ?? []).map((s) => s.id));
    const toReload = loaded.filter((id) => validIds.has(id));
    set((s) => {
      const pruned: Record<Id, readonly AnimeEpisode[]> = {};
      for (const id of toReload) {
        const existing = s.episodes[id];
        if (existing) pruned[id] = existing;
      }
      return { episodes: pruned };
    });
    await Promise.all(toReload.map((id) => get().loadEpisodes(host, id)));
  },
  reset() {
    set({ series: undefined, episodes: {}, loading: false, error: undefined });
  },
}));
