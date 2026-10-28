/**
 * `RestPlatformHost`: the browser-side `PlatformHost` that talks to the local
 * Kotori Node server over REST (`/api/*`) + SSE (`/api/events`). Every method is
 * a thin call through the shared route table, so client and server can never
 * disagree about URLs or argument encoding. Browser-safe.
 */
import { KotoriError } from '@kotori/core';
import type {
  DictionaryHost,
  DictionaryImportSource,
  DictionaryInfo,
  FollowUpDelta,
  FollowUpMessage,
  HostCapabilities,
  HostEvent,
  HostInfo,
  KotoriErrorShape,
  PlatformHost,
} from '@kotori/core';
import { EVENTS_PATH, INFO_PATH, ROUTES, buildQuery, type RoutedMethodKey, type WireArgs, type HostResult } from '../shared';
import { createHttpClient, decodeEnvelope, type FetchLike, type HttpClient } from './http';
import { HostEventStream, readSseResponse } from './events';

export interface RestPlatformHostOptions {
  /** Origin of the Kotori server; defaults to `window.location.origin` (or same-origin relative URLs). */
  readonly baseUrl?: string;
  /** Injected `fetch` (tests); defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Pre-fetched host info; otherwise conservative desktop defaults until `refreshInfo()`. */
  readonly info?: HostInfo;
  /** Timeout for non-AI calls (ms). Default 60 s. */
  readonly timeoutMs?: number;
}

export type CreateRestPlatformHost = (options?: RestPlatformHostOptions) => RestPlatformHost;

export interface RestPlatformHost extends PlatformHost {
  /** Always present on desktop (local SQLite dictionaries). */
  readonly dict: DictionaryHost;
  /** Re-fetch `GET /api/info` (capabilities may change, e.g. ffmpeg discovered). */
  refreshInfo(): Promise<HostInfo>;
}

/**
 * `dict.importZip`: uploaded bytes go as a raw `application/zip` body (no
 * base64 inflation); every other source is the route-table JSON body. No
 * client timeout — large dictionaries take a while to download and import.
 */
function importDictionary(http: HttpClient, source: DictionaryImportSource): Promise<DictionaryInfo> {
  if (source.bytes === undefined) return http.call('dict.importZip', [source], { timeoutMs: 0 });
  const query: Record<string, string> = {};
  if (source.fileName) query['fileName'] = source.fileName;
  if (source.attribution) query['attribution'] = source.attribution;
  if (source.indexUrl) query['indexUrl'] = source.indexUrl;
  return http.postBytes<DictionaryInfo>(ROUTES['dict.importZip'].path + buildQuery(query), source.bytes, 'application/zip', { timeoutMs: 0 });
}

export const DEFAULT_DESKTOP_CAPABILITIES: HostCapabilities = {
  torrent: true,
  embeddedSubtitles: false,
  vertexAdc: true,
  directoryPicker: false,
  filePicker: false,
  pathBrowser: true,
  streaming: true,
  openExternal: true,
};

function defaultInfo(): HostInfo {
  return { platform: 'node', os: 'unknown', version: '0.0.0', capabilities: DEFAULT_DESKTOP_CAPABILITIES, dataDir: '' };
}

function resolveBaseUrl(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin && loc.origin !== 'null' ? loc.origin : '';
}

function resolveFetch(explicit: FetchLike | undefined): FetchLike {
  if (explicit) return explicit;
  if (typeof globalThis.fetch !== 'function') throw new KotoriError('unsupported', 'fetch is not available');
  return (input, init) => globalThis.fetch(input, init);
}

/** Create a REST host synchronously (info defaults until `refreshInfo()`). */
export const createRestPlatformHost: CreateRestPlatformHost = (options = {}) => {
  const fetchFn = resolveFetch(options.fetch);
  const http: HttpClient = createHttpClient({ baseUrl: resolveBaseUrl(options.baseUrl), fetch: fetchFn, timeoutMs: options.timeoutMs ?? 60_000 });
  const events = new HostEventStream({ url: http.baseUrl + EVENTS_PATH, fetch: fetchFn });
  let info: HostInfo = options.info ?? defaultInfo();

  /** Shorthand for a routed call with the default timeout. */
  const call = <K extends RoutedMethodKey>(key: K, ...args: WireArgs<K>): Promise<HostResult<K>> => http.call(key, args);
  /** AI calls: caller signal, no client-side timeout (the server enforces `AiSettings.timeoutMs`). */
  const aiCall = <K extends RoutedMethodKey>(key: K, signal: AbortSignal | undefined, ...args: WireArgs<K>): Promise<HostResult<K>> =>
    http.call(key, args, { signal, timeoutMs: 0 });

  const host: RestPlatformHost = {
    get info() {
      return info;
    },
    async refreshInfo() {
      info = await http.getJson<HostInfo>(INFO_PATH);
      return info;
    },
    settings: {
      get: () => call('settings.get'),
      update: (patch) => call('settings.update', patch),
      testAi: (settings) => (settings === undefined ? aiCall('settings.testAi', undefined) : aiCall('settings.testAi', undefined, settings)),
    },
    anime: {
      listSeries: () => call('anime.listSeries'),
      getSeries: (id) => call('anime.getSeries', id),
      listEpisodes: (id) => call('anime.listEpisodes', id),
      getEpisode: (id) => call('anime.getEpisode', id),
      importSeries: (request) => call('anime.importSeries', request),
      removeSeries: (id, deleteFiles) => (deleteFiles === undefined ? call('anime.removeSeries', id) : call('anime.removeSeries', id, deleteFiles)),
      rescanSeries: (id) => call('anime.rescanSeries', id),
      getCues: (trackId) => call('anime.getCues', trackId),
      addSubtitleTrack: (episodeId, input) => call('anime.addSubtitleTrack', episodeId, input),
      extractEmbeddedTrack: (episodeId, streamIndex) => http.call('anime.extractEmbeddedTrack', [episodeId, streamIndex], { timeoutMs: 0 }),
      removeSubtitleTrack: (trackId) => call('anime.removeSubtitleTrack', trackId),
      setTrackDelay: (trackId, delayMs) => call('anime.setTrackDelay', trackId, delayMs),
      setDefaultTrack: (episodeId, trackId) => call('anime.setDefaultTrack', episodeId, trackId),
      saveProgress: (episodeId, progress) => call('anime.saveProgress', episodeId, progress),
      autoFetchJimaku: (seriesId, opts) => (opts === undefined ? call('anime.autoFetchJimaku', seriesId) : call('anime.autoFetchJimaku', seriesId, opts)),
    },
    manga: {
      listVolumes: () => call('manga.listVolumes'),
      getVolume: (id) => call('manga.getVolume', id),
      importVolume: (request) => http.call('manga.importVolume', [request], { timeoutMs: 0 }),
      removeVolume: (id, deleteFiles) => (deleteFiles === undefined ? call('manga.removeVolume', id) : call('manga.removeVolume', id, deleteFiles)),
      getPage: (id, pageIndex) => call('manga.getPage', id, pageIndex),
      getPages: (id) => call('manga.getPages', id),
      setReadingMode: (id, mode) => call('manga.setReadingMode', id, mode),
      setCoverIsSingle: (id, single) => call('manga.setCoverIsSingle', id, single),
      saveProgress: (id, progress) => call('manga.saveProgress', id, progress),
      addBlocks: (id, pageIndex, blocks) => call('manga.addBlocks', id, pageIndex, blocks),
    },
    ai: {
      explain: (request, opts) => aiCall('ai.explain', opts?.signal, request),
      explainBatch: (requests, opts) => aiCall('ai.explainBatch', opts?.signal, requests),
      getCachedExplanation: (request) => call('ai.getCachedExplanation', request),
      followUp: (request, opts) => aiCall('ai.followUp', opts?.signal, request),
      followUpStream: (request, onDelta, opts) => followUpStream(http, request, onDelta, opts?.signal),
      ocrBubble: (request, opts) => aiCall('ai.ocrBubble', opts?.signal, request),
      pageGuide: (request, opts) => aiCall('ai.pageGuide', opts?.signal, request),
      getThread: (explanationId) => call('ai.getThread', explanationId),
      clearCache: () => call('ai.clearCache'),
    },
    downloads: {
      searchNyaa: (query) => call('downloads.searchNyaa', query),
      searchJimaku: (query) => call('downloads.searchJimaku', query),
      listJimakuFiles: (entryId, episode) => (episode === undefined ? call('downloads.listJimakuFiles', entryId) : call('downloads.listJimakuFiles', entryId, episode)),
      browseMokuroCatalog: (url) => (url === undefined ? call('downloads.browseMokuroCatalog') : call('downloads.browseMokuroCatalog', url)),
      list: () => call('downloads.list'),
      get: (taskId) => call('downloads.get', taskId),
      start: (request) => call('downloads.start', request),
      pause: (taskId) => call('downloads.pause', taskId),
      resume: (taskId) => call('downloads.resume', taskId),
      cancel: (taskId) => call('downloads.cancel', taskId),
      remove: (taskId, deleteFiles) => (deleteFiles === undefined ? call('downloads.remove', taskId) : call('downloads.remove', taskId, deleteFiles)),
      selectFiles: (taskId, fileIndexes) => call('downloads.selectFiles', taskId, fileIndexes),
    },
    files: {
      // Desktop has no native pickers in the browser; the UI uses the path browser.
      listDirectory: (path) => (path === undefined ? call('files.listDirectory') : call('files.listDirectory', path)),
      openExternal: (url) => call('files.openExternal', url),
    },
    dict: {
      list: () => call('dict.list'),
      importZip: (source) => importDictionary(http, source),
      update: (id, patch) => call('dict.update', id, patch),
      remove: (id) => call('dict.remove', id),
      enrichVocab: (vocab) => call('dict.enrichVocab', vocab),
      lookupPrefix: (text, maxLength) => (maxLength === undefined ? call('dict.lookupPrefix', text) : call('dict.lookupPrefix', text, maxLength)),
    },
    subscribe: (listener: (event: HostEvent) => void) => events.subscribe(listener),
    async dispose() {
      events.close();
    },
  };
  return host;
};

/** Create a REST host after fetching `GET /api/info` so capabilities are accurate. */
export async function connectRestPlatformHost(options: RestPlatformHostOptions = {}): Promise<RestPlatformHost> {
  const host = createRestPlatformHost(options);
  await host.refreshInfo();
  return host;
}

/**
 * `POST /api/ai/follow-up/stream`: the server answers with SSE where each
 * default event is a `FollowUpDelta`, then `event: done` carrying the final
 * `FollowUpMessage` or `event: error` carrying a `KotoriErrorShape`.
 */
async function followUpStream(
  http: HttpClient,
  request: Parameters<NonNullable<PlatformHost['ai']['followUpStream']>>[0],
  onDelta: (delta: FollowUpDelta) => void,
  signal: AbortSignal | undefined,
): Promise<FollowUpMessage> {
  const res = await http.request('ai.followUpStream', [request], { signal, timeoutMs: 0 });
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // Error before streaming started → regular JSON envelope.
    return decodeEnvelope<FollowUpMessage>(res);
  }
  let final: FollowUpMessage | undefined;
  let failure: KotoriErrorShape | undefined;
  try {
    await readSseResponse(
      res,
      (msg) => {
        if (msg.event === 'done') final = JSON.parse(msg.data) as FollowUpMessage;
        else if (msg.event === 'error') failure = JSON.parse(msg.data) as KotoriErrorShape;
        else onDelta(JSON.parse(msg.data) as FollowUpDelta);
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw new KotoriError('cancelled', 'Request cancelled');
    throw KotoriError.wrap(error, 'network');
  }
  if (signal?.aborted) throw new KotoriError('cancelled', 'Request cancelled');
  if (failure) throw KotoriError.fromShape(failure);
  if (!final) throw new KotoriError('network', 'Follow-up stream ended without a final message');
  return final;
}
