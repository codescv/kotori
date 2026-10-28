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
  CompactTermRecord,
  DictMetaRecord,
  DictionaryInfo,
  DownloadTask,
  FollowUpMessage,
  MangaPage,
  MangaVolume,
  SentenceExplanation,
  SubtitleTrack,
} from '@kotori/core';

export const DB_VERSION = 2;

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
  /** v2: imported Yomitan dictionaries (`status: 'importing'` rows are purged on startup). */
  dictionaries: { key: string; value: DictionaryInfo };
  /** v2: compact term rows; `byKey` is multiEntry over `keys` (expression + reading). */
  dictTerms: { key: [string, number]; value: CompactTermRecord; indexes: { byKey: string } };
  /** v2: one merged pitch / freq record per `(dictId, expression, mode)`. */
  dictMeta: { key: [string, string, string]; value: DictMetaRecord; indexes: { byExprMode: [string, string] } };
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
    if (event.oldVersion < 2) {
      db.createObjectStore('dictionaries', { keyPath: 'id' });
      db.createObjectStore('dictTerms', { keyPath: ['dictId', 'seq'] }).createIndex('byKey', 'keys', { multiEntry: true });
      db.createObjectStore('dictMeta', { keyPath: ['dictId', 'expression', 'mode'] }).createIndex('byExprMode', ['expression', 'mode']);
    }
  };
  // `wrap` is schema-agnostic; the schema above is what `onupgradeneeded` creates.
  const db = (await wrap(request)) as unknown as KotoriDb;
  return db;
}
