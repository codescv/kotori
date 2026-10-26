/**
 * IndexedDB schema (via `idb`) mirroring the desktop SQLite tables
 * (ARCHITECTURE.md §5.2). Records are the `types.ts` shapes minus fields the
 * host resolves at read time (`mediaUrl`, `imageUrl`, `coverUrl`,
 * `subtitleTracks`). The factory is injected so tests can use
 * `fake-indexeddb` instances.
 */
import { wrap, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AnimeEpisode,
  AnimeSeries,
  AppSettings,
  DownloadTask,
  FollowUpMessage,
  MangaPage,
  MangaVolume,
  SentenceExplanation,
  SubtitleTrack,
} from '@kotori/core';

export const DB_VERSION = 1;

export type StoredSeries = AnimeSeries;
export type StoredEpisode = Omit<AnimeEpisode, 'mediaUrl' | 'subtitleTracks'>;
export type StoredTrack = SubtitleTrack;

export type StoredVolume = Omit<MangaVolume, 'coverUrl'> & {
  /** Absolute directory page `relativePath`s resolve against. */
  readonly imageRoot: string;
  /** True when pages were extracted into app data (deleted with the volume). */
  readonly ownsFiles: boolean;
  /** `relativePath` of page 0 (cover). */
  readonly coverRelativePath?: string;
};

export type StoredPage = Omit<MangaPage, 'imageUrl'> & { readonly volumeId: string };

export interface StoredThread {
  readonly explanationId: string;
  readonly messages: readonly FollowUpMessage[];
}

export interface KotoriDbSchema extends DBSchema {
  settings: { key: string; value: AppSettings };
  series: { key: string; value: StoredSeries };
  episodes: { key: string; value: StoredEpisode; indexes: { bySeries: string } };
  tracks: { key: string; value: StoredTrack; indexes: { byEpisode: string } };
  volumes: { key: string; value: StoredVolume };
  pages: { key: [string, number]; value: StoredPage; indexes: { byVolume: string } };
  explanations: { key: string; value: SentenceExplanation };
  threads: { key: string; value: StoredThread };
  downloads: { key: string; value: DownloadTask };
}

export type KotoriDb = IDBPDatabase<KotoriDbSchema>;

/** Open (and migrate) the Kotori database. */
export async function openKotoriDb(factory: IDBFactory, name: string): Promise<KotoriDb> {
  const request = factory.open(name, DB_VERSION);
  request.onupgradeneeded = (event) => {
    const db = request.result;
    if (event.oldVersion < 1) {
      db.createObjectStore('settings');
      db.createObjectStore('series', { keyPath: 'id' });
      db.createObjectStore('episodes', { keyPath: 'id' }).createIndex('bySeries', 'seriesId');
      db.createObjectStore('tracks', { keyPath: 'id' }).createIndex('byEpisode', 'episodeId');
      db.createObjectStore('volumes', { keyPath: 'id' });
      db.createObjectStore('pages', { keyPath: ['volumeId', 'index'] }).createIndex('byVolume', 'volumeId');
      db.createObjectStore('explanations', { keyPath: 'id' });
      db.createObjectStore('threads', { keyPath: 'explanationId' });
      db.createObjectStore('downloads', { keyPath: 'id' });
    }
  };
  // `wrap` is schema-agnostic; the schema above is what `onupgradeneeded` creates.
  const db = (await wrap(request)) as unknown as KotoriDb;
  return db;
}
