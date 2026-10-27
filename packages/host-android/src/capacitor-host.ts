/**
 * `CapacitorPlatformHost` — the in-process `PlatformHost` for the Android
 * WebView (ARCHITECTURE.md §7). Runs entirely in the WebView: IndexedDB
 * (`storage/idb.ts`) for metadata, `@capacitor/filesystem` (`storage/files.ts`)
 * for app files, direct `fetch` for Gemini / Jimaku / mokuro.moe / Nyaa.
 *
 * Capabilities: torrent ✗ (magnets handed off to an external app, see
 * `downloads.ts`), embeddedSubtitles ✗ (no ffmpeg), vertexAdc ✗, directory
 * and file pickers ✓ (see the picker decision in `default-deps.ts`),
 * pathBrowser ✗ (`files.listDirectory` is absent), streaming ✓, openExternal ✓.
 *
 * Every dependency is injectable (`Partial<CapacitorHostDeps>`) for tests.
 */
import type {
  AiApi,
  AnimeApi,
  DownloadsApi,
  FilesApi,
  HostCapabilities,
  HostEvent,
  MangaApi,
  PlatformHost,
  SettingsApi,
} from '@kotori/core';
import { createAndroidAi } from './ai';
import type { HostContext } from './context';
import { resolveDeps } from './default-deps';
import type { CapacitorHostDeps } from './deps';
import { createDownloadManager, type DownloadManager } from './downloads';
import { createAnimeLibrary } from './library/anime';
import { createMangaLibrary } from './library/manga';
import { createSettingsStore, defaultSettings } from './settings';
import { appDirs } from './storage/files';
import { openKotoriDb } from './storage/idb';

export const ANDROID_CAPABILITIES: HostCapabilities = {
  torrent: true,
  embeddedSubtitles: false,
  vertexAdc: false,
  directoryPicker: true,
  filePicker: true,
  pathBrowser: false,
  streaming: true,
  openExternal: true,
};

/** Create the Android host. Missing deps default to the Capacitor implementations. */
export async function createCapacitorPlatformHost(overrides: Partial<CapacitorHostDeps> = {}): Promise<PlatformHost> {
  const deps = await resolveDeps(overrides);
  const listeners = new Set<(event: HostEvent) => void>();
  const emit = (event: HostEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[kotori:host-android] listener failed', error);
      }
    }
  };

  const db = await openKotoriDb(deps.idbFactory, deps.dbName);
  const dirs = appDirs(deps.dataRoot);
  const settingsStore = await createSettingsStore(db, defaultSettings(dirs.downloads), emit);
  const ctx: HostContext = { deps, db, dirs, settings: settingsStore, emit };

  // anime ⇄ downloads are mutually dependent (autoFetchJimaku / auto-import): late-bind.
  let downloadManager: DownloadManager | undefined;
  const animeLib = createAnimeLibrary(ctx, {
    startDownload: (request) => {
      if (!downloadManager) throw new Error('download manager not ready');
      return downloadManager.start(request);
    },
  });
  const mangaLib = createMangaLibrary(ctx);
  const dl = createDownloadManager(ctx, { anime: animeLib, manga: mangaLib });
  downloadManager = dl;
  await dl.init();
  const engine = createAndroidAi(ctx);

  const settings: SettingsApi = {
    get: () => settingsStore.get(),
    update: (patch) => settingsStore.update(patch),
    testAi: (ai) => engine.testAi(ai),
  };

  const anime: AnimeApi = {
    listSeries: () => animeLib.listSeries(),
    getSeries: (id) => animeLib.getSeries(id),
    listEpisodes: (id) => animeLib.listEpisodes(id),
    getEpisode: (id) => animeLib.getEpisode(id),
    importSeries: (request) => animeLib.importSeries(request),
    removeSeries: (id, deleteFiles) => animeLib.removeSeries(id, deleteFiles),
    rescanSeries: (id) => animeLib.rescanSeries(id),
    getCues: (trackId) => animeLib.getCues(trackId),
    addSubtitleTrack: (episodeId, input) => animeLib.addSubtitleTrack(episodeId, input),
    extractEmbeddedTrack: (episodeId, streamIndex) => animeLib.extractEmbeddedTrack(episodeId, streamIndex),
    removeSubtitleTrack: (trackId) => animeLib.removeSubtitleTrack(trackId),
    setTrackDelay: (trackId, delayMs) => animeLib.setTrackDelay(trackId, delayMs),
    setDefaultTrack: (episodeId, trackId) => animeLib.setDefaultTrack(episodeId, trackId),
    saveProgress: (episodeId, progress) => animeLib.saveProgress(episodeId, progress),
    autoFetchJimaku: (seriesId, options) => animeLib.autoFetchJimaku(seriesId, options),
  };

  const manga: MangaApi = {
    listVolumes: () => mangaLib.listVolumes(),
    getVolume: (id) => mangaLib.getVolume(id),
    importVolume: (request) => mangaLib.importVolume(request),
    removeVolume: (id, deleteFiles) => mangaLib.removeVolume(id, deleteFiles),
    getPage: (id, index) => mangaLib.getPage(id, index),
    getPages: (id) => mangaLib.getPages(id),
    setReadingMode: (id, mode) => mangaLib.setReadingMode(id, mode),
    setCoverIsSingle: (id, single) => mangaLib.setCoverIsSingle(id, single),
    saveProgress: (id, progress) => mangaLib.saveProgress(id, progress),
    addBlocks: (id, index, blocks) => mangaLib.addBlocks(id, index, blocks),
  };

  const ai: AiApi = {
    explain: (request, options) => engine.explain(request, options),
    getCachedExplanation: (request) => engine.getCachedExplanation(request),
    followUp: (request, options) => engine.followUp(request, options),
    followUpStream: (request, onDelta, options) => engine.followUpStream(request, onDelta, options),
    ocrBubble: (request, options) => engine.ocrBubble(request, options),
    pageGuide: (request, options) => engine.pageGuide(request, options),
    getThread: (id) => engine.getThread(id),
    clearCache: () => engine.clearCache(),
  };

  const downloads: DownloadsApi = {
    searchNyaa: (query) => dl.searchNyaa(query),
    searchJimaku: (query) => dl.searchJimaku(query),
    listJimakuFiles: (entryId, episode) => dl.listJimakuFiles(entryId, episode),
    browseMokuroCatalog: (url) => dl.browseMokuroCatalog(url),
    list: () => dl.list(),
    get: (id) => dl.get(id),
    start: (request) => dl.start(request),
    pause: (id) => dl.pause(id),
    resume: (id) => dl.resume(id),
    cancel: (id) => dl.cancel(id),
    remove: (id, deleteFiles) => dl.remove(id, deleteFiles),
    selectFiles: (id, indexes) => dl.selectFiles(id, indexes),
  };

  // No `listDirectory`: Android has no path browser (capabilities.pathBrowser = false).
  const files: FilesApi = {
    pickDirectory: () => deps.pickDirectory(),
    pickFiles: (options) => deps.pickFiles(options),
    openExternal: (url) => deps.openExternal(url),
  };

  let disposed: Promise<void> | undefined;
  return {
    info: { platform: 'android', os: 'android', version: deps.version, capabilities: ANDROID_CAPABILITIES, dataDir: deps.dataRoot },
    settings,
    anime,
    manga,
    ai,
    downloads,
    files,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed ??= (async () => {
        await dl.dispose();
        await Promise.all([animeLib.flush(), mangaLib.flush()]);
        listeners.clear();
        db.close();
      })();
      return disposed;
    },
  };
}
