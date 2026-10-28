/**
 * `ServerContext`: everything a request handler needs — database,
 * repositories, settings, event hub, AI service, download manager, ffmpeg —
 * plus `host`, the server-side implementation of every routed `PlatformHost`
 * group (the REST layer dispatches to it generically via the route table).
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AnimeApi, DownloadsApi, HostCapabilities, HostInfo, MangaApi, SettingsApi } from '@kotori/core';
import { adcTokenProvider } from '../ai/credentials';
import { createAiService, type HostAiService } from '../ai/service';
import { createRepositories, type Repositories } from '../db/repositories';
import { openDatabase, type Database } from '../db/sqlite';
import { DownloadManager } from '../downloads/manager';
import type { TorrentEngine } from '../downloads/torrent-engine';
import { SubtitleStore } from '../library/subtitle-store';
import { findFfmpeg, type FfmpegPaths } from '../media/ffmpeg';
import { SettingsStore } from '../settings/store';
import { TorrentClient } from '../torrent';
import type { ServerOptions } from './index';
import { attachJimakuSubtitle, createAnimeService, type NodeAnimeService } from './services/anime';
import { createDownloadsService, createFilesService, type NodeFilesApi, type Opener } from './services/downloads';
import { createMangaService, type NodeMangaService } from './services/manga';
import { EventHub } from './util';

export const KOTORI_VERSION = '0.1.17';

/** Server-side implementation of the routed `PlatformHost` groups. */
export interface NodeHost {
  readonly settings: SettingsApi;
  readonly anime: NodeAnimeService;
  readonly manga: NodeMangaService;
  readonly ai: HostAiService;
  readonly downloads: DownloadsApi;
  readonly files: NodeFilesApi;
}

export interface ServerContext {
  readonly options: ServerOptions;
  readonly info: HostInfo;
  readonly db: Database;
  readonly repos: Repositories;
  readonly settings: SettingsStore;
  readonly events: EventHub;
  readonly downloads: DownloadManager;
  readonly subtitles: SubtitleStore;
  readonly ffmpeg: FfmpegPaths | undefined;
  readonly host: NodeHost;
  close(): Promise<void>;
}

/** Test / embedding overrides. */
export interface ContextOverrides {
  readonly fetch?: typeof fetch;
  /** `null` = pretend ffmpeg is absent; `undefined` = auto-detect. */
  readonly ffmpeg?: FfmpegPaths | null;
  readonly torrentEngine?: () => TorrentEngine;
  readonly adc?: () => Promise<string>;
  readonly opener?: Opener;
  readonly home?: string;
  readonly now?: () => number;
}

function osName(): HostInfo['os'] {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    default:
      return 'unknown';
  }
}

export async function createServerContext(options: ServerOptions, overrides: ContextOverrides = {}): Promise<ServerContext> {
  const dataDir = resolve(options.dataDir);
  for (const sub of ['subtitles', 'anime', 'downloads', 'manga', 'cache', 'torrents']) mkdirSync(join(dataDir, sub), { recursive: true });
  const db = openDatabase(join(dataDir, 'kotori.sqlite'));
  const repos = createRepositories(db);
  const settings = new SettingsStore(db, dataDir);
  const events = new EventHub();
  const emit = events.emit.bind(events);
  const subtitles = new SubtitleStore(dataDir);
  const fetchFn = overrides.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const ffmpeg = overrides.ffmpeg === null ? undefined : (overrides.ffmpeg ?? (await findFfmpeg()));
  const now = overrides.now;

  const capabilities: HostCapabilities = {
    torrent: true,
    embeddedSubtitles: ffmpeg !== undefined,
    vertexAdc: true,
    directoryPicker: false,
    filePicker: false,
    pathBrowser: true,
    streaming: true,
    openExternal: true,
  };
  const info: HostInfo = { platform: 'node', os: osName(), version: KOTORI_VERSION, capabilities, dataDir };

  const ai = createAiService({
    repos,
    settings: () => settings.get().ai,
    adc: overrides.adc ?? adcTokenProvider(),
    fetch: fetchFn,
    ...(now ? { now } : {}),
  });

  // Late-bound to break the anime ⇄ downloads cycle.
  let manager: DownloadManager | undefined;
  const getManager = (): DownloadManager => {
    if (!manager) throw new Error('download manager not initialised');
    return manager;
  };

  const anime = createAnimeService({ db, repos, settings, subtitles, emit, ffmpeg: () => ffmpeg, downloads: getManager, fetch: fetchFn, ...(now ? { now } : {}) });
  const manga = createMangaService({ db, repos, dataDir, emit, ...(now ? { now } : {}) });

  const torrentEngine =
    overrides.torrentEngine ??
    ((): TorrentEngine => {
      const s = settings.get().downloads;
      return new TorrentClient({
        dataDir: join(dataDir, 'torrents'),
        maxPeersPerTorrent: s.maxPeersPerTorrent,
        ...(s.downloadLimitBps !== undefined ? { downloadLimitBps: s.downloadLimitBps } : {}),
        ...(s.uploadLimitBps !== undefined ? { uploadLimitBps: s.uploadLimitBps } : {}),
      });
    });

  manager = new DownloadManager({
    repo: repos.downloads,
    settings: () => settings.get(),
    emit,
    dataDir,
    fetch: fetchFn,
    torrentEngine,
    ...(now ? { now } : {}),
    hooks: {
      importAnime: async (path, importOpts) => ({
        seriesId: (
          await anime.importSeries({
            path,
            ...(importOpts?.titleOverride ? { titleOverride: importOpts.titleOverride } : {}),
            ...(importOpts?.anilistId !== undefined ? { anilistId: importOpts.anilistId } : {}),
            ...(importOpts?.coverUrl ? { coverUrl: importOpts.coverUrl } : {}),
          })
        ).id,
      }),
      importManga: async (path) => ({ volumeId: (await manga.importVolume({ path })).id }),
      attachSubtitle: async (episodeId, filePath, fileName) => ({ trackId: (await attachJimakuSubtitle({ repos, subtitles, ...(now ? { now } : {}) }, episodeId, filePath, fileName)).id }),
      listEpisodes: (seriesId) => anime.listEpisodes(seriesId),
      listSeries: () => anime.listSeries(),
      autoFetchSubtitles: async (seriesId, seriesMeta) => {
        const aliases = [seriesMeta?.romajiTitle, seriesMeta?.nativeTitle, seriesMeta?.englishTitle, seriesMeta?.title].filter(
          (s): s is string => Boolean(s && s.trim()),
        );
        await anime.autoFetchJimaku(seriesId, {
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(seriesMeta?.anilistId !== undefined ? { anilistId: seriesMeta.anilistId } : {}),
        });
      },
    },
  });
  manager.init();
  if (!process.env['VITEST'] && !overrides.home) {
    void anime.scanRoots().catch(() => undefined);
  }

  const settingsApi: SettingsApi = {
    get: async () => settings.get(),
    update: async (patch) => {
      const next = settings.update(patch);
      emit({ type: 'settings-changed', settings: next });
      if (patch.library?.animeRoots !== undefined || patch.downloads?.downloadDir !== undefined) {
        void anime.scanRoots(next.library.animeRoots).catch(() => undefined);
      }
      return next;
    },
    testAi: (override) => ai.testConnection(override ?? settings.get().ai),
  };

  const host: NodeHost = {
    settings: settingsApi,
    anime,
    manga,
    ai,
    downloads: createDownloadsService({ settings, manager: getManager, fetch: fetchFn }),
    files: createFilesService({ ...(overrides.opener ? { opener: overrides.opener } : {}), ...(overrides.home ? { home: overrides.home } : {}) }),
  };

  let closed = false;
  return {
    options,
    info,
    db,
    repos,
    settings,
    events,
    downloads: manager,
    subtitles,
    ffmpeg,
    host,
    async close() {
      if (closed) return;
      closed = true;
      await manager?.dispose();
      await anime.idle();
      db.close();
    },
  };
}

/** Type-level guard: the server host implements the routed `PlatformHost` groups. */
export type _HostConformance = [NodeHost['anime'] extends AnimeApi ? true : never, NodeHost['manga'] extends MangaApi ? true : never];
