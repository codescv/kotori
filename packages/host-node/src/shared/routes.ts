/**
 * Typed REST route table for every `PlatformHost` method (ARCHITECTURE.md §3.1).
 * Browser-safe: no `node:*` imports.
 *
 * Each entry declares the HTTP method + Hono-style path template and a codec:
 * `encode(...args)` turns the method's arguments into a {@link WireRequest}
 * (client side) and `decode(wire)` rebuilds them (server side). Because both
 * sides use the *same* table, URL/argument drift is impossible; a test asserts
 * every `PlatformHost` method has an entry (or is explicitly client-only).
 */
import type {
  AiCallOptions,
  AiSettings,
  AnimeImportRequest,
  AnimeSeriesUpdatePatch,
  DictionaryImportSource,
  DownloadRequest,
  ExplainRequest,
  FollowUpRequest,
  Id,
  JimakuSearchQuery,
  LanguageTag,
  MangaBlock,
  MangaBubbleOcrRequest,
  MangaImportRequest,
  MangaPageGuideRequest,
  MangaReadingMode,
  MangaReadingProgress,
  NyaaSearchQuery,
  PlaybackProgress,
  PlatformHost,
  SettingsPatch,
  VocabEntry,
} from '@kotori/core';

export const API_PREFIX = '/api' as const;
/** Server-Sent Events stream of `HostEvent` JSON payloads. */
export const EVENTS_PATH = `${API_PREFIX}/events` as const;
/** Host info (`HostInfo`, incl. capabilities). */
export const INFO_PATH = `${API_PREFIX}/info` as const;
/** HTTP Range video stream. */
export const MEDIA_PATH = '/media/:episodeId' as const;
/** Manga page image bytes. */
export const MANGA_IMAGE_PATH = `${API_PREFIX}/manga/volumes/:volumeId/pages/:pageIndex/image` as const;

export function mediaUrlFor(episodeId: Id): string {
  return `/media/${encodeURIComponent(episodeId)}`;
}

export function mangaImageUrlFor(volumeId: Id, pageIndex: number): string {
  return `${API_PREFIX}/manga/volumes/${encodeURIComponent(volumeId)}/pages/${pageIndex}/image`;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Transport-neutral request description produced by `encode` / consumed by `decode`. */
export interface WireRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

type HostGroup = 'settings' | 'anime' | 'manga' | 'ai' | 'downloads' | 'files' | 'dict';

/** Group API object (`dict` is optional on `PlatformHost`, so strip `undefined`). */
type GroupApi<G extends HostGroup> = NonNullable<PlatformHost[G]>;

type MethodNames<G extends HostGroup> = {
  [K in keyof GroupApi<G>]-?: NonNullable<GroupApi<G>[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof GroupApi<G>] &
  string;

/** `'anime.getCues'`, `'ai.explain'`, … — every method of every `PlatformHost` group. */
export type HostMethodKey = { [G in HostGroup]: `${G}.${MethodNames<G>}` }[HostGroup];

/** Methods that are never routed over REST (desktop uses `files.listDirectory` instead of native pickers). */
export const CLIENT_ONLY_METHODS = ['files.pickDirectory', 'files.pickFiles'] as const;
export type ClientOnlyMethodKey = (typeof CLIENT_ONLY_METHODS)[number];
export type RoutedMethodKey = Exclude<HostMethodKey, ClientOnlyMethodKey>;

export type HostMethod<K extends HostMethodKey> = K extends `${infer G}.${infer M}`
  ? G extends HostGroup
    ? M extends keyof GroupApi<G>
      ? NonNullable<GroupApi<G>[M]>
      : never
    : never
  : never;

type AnyFn = (...args: never[]) => unknown;
export type HostArgs<K extends HostMethodKey> = HostMethod<K> extends AnyFn ? Parameters<HostMethod<K>> : never;
export type HostResult<K extends HostMethodKey> = HostMethod<K> extends AnyFn ? Awaited<ReturnType<HostMethod<K>>> : never;

/** Methods taking a trailing `AiCallOptions` (not serialisable; mapped to fetch `signal`). */
type AiOptionMethods = 'ai.explain' | 'ai.explainBatch' | 'ai.followUp' | 'ai.ocrBubble' | 'ai.pageGuide';

/** Arguments that actually travel over the wire (callbacks / AbortSignals stripped). */
export type WireArgs<K extends HostMethodKey> = K extends 'ai.followUpStream'
  ? [request: FollowUpRequest]
  : K extends AiOptionMethods
    ? [request: HostArgs<K>[0]]
    : HostArgs<K>;

export interface RouteDef<K extends RoutedMethodKey> {
  readonly method: HttpMethod;
  readonly path: string;
  /** Response is `text/event-stream` (only `ai.followUpStream`). */
  readonly stream?: boolean;
  readonly encode: (...args: WireArgs<K>) => WireRequest;
  readonly decode: (wire: WireRequest) => WireArgs<K>;
}

export type RouteTable = { readonly [K in RoutedMethodKey]: RouteDef<K> };

// ---------------------------------------------------------------------------
// codec helpers
// ---------------------------------------------------------------------------

const NO_QUERY: Readonly<Record<string, string>> = Object.freeze({});

function req(params: Record<string, string> = {}, query: Record<string, string> = {}, body?: unknown): WireRequest {
  return body === undefined ? { params, query } : { params, query, body };
}

function p(wire: WireRequest, name: string): string {
  const value = wire.params[name];
  if (value === undefined) throw new TypeError(`missing path parameter :${name}`);
  return value;
}

function int(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`parameter ${name} must be an integer, got ${JSON.stringify(value)}`);
  return n;
}

function flag(value: boolean | undefined): Record<string, string> {
  return value === undefined ? {} : { deleteFiles: value ? '1' : '0' };
}

function readFlag(wire: WireRequest, name: string): boolean | undefined {
  const v = wire.query[name];
  if (v === undefined) return undefined;
  return v === '1' || v === 'true';
}

function body<T>(wire: WireRequest): T {
  return wire.body as T;
}

function field<T>(wire: WireRequest, key: string): T {
  const b = wire.body;
  if (typeof b !== 'object' || b === null) throw new TypeError('request body must be a JSON object');
  return (b as Record<string, unknown>)[key] as T;
}

const BASE64_CHUNK = 0x8000;

/** Uint8Array → base64 (browser-safe, chunked so large buffers do not overflow the stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  return btoa(binary);
}

/** base64 → Uint8Array (browser-safe). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JSON body of `dict.importZip`: `bytes` travels as `bytesBase64`. */
function encodeImportSource(source: DictionaryImportSource): Record<string, unknown> {
  const { bytes, ...rest } = source;
  return bytes === undefined ? { ...rest } : { ...rest, bytesBase64: bytesToBase64(bytes) };
}

function decodeImportSource(wire: WireRequest): DictionaryImportSource {
  const b = wire.body;
  if (typeof b !== 'object' || b === null) throw new TypeError('request body must be a JSON object');
  const { bytesBase64, ...rest } = b as Record<string, unknown> & { bytesBase64?: unknown };
  const out: Record<string, unknown> = {};
  for (const key of ['filePath', 'url', 'presetId', 'fileName', 'attribution', 'indexUrl'] as const) {
    const v = rest[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new TypeError(`${key} must be a string`);
    out[key] = v;
  }
  if (bytesBase64 !== undefined && bytesBase64 !== null) {
    if (typeof bytesBase64 !== 'string') throw new TypeError('bytesBase64 must be a base64 string');
    out['bytes'] = base64ToBytes(bytesBase64);
  }
  return out as DictionaryImportSource;
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

export const ROUTES: RouteTable = {
  // --- settings --------------------------------------------------------------
  'settings.get': { method: 'GET', path: '/api/settings', encode: () => req(), decode: () => [] },
  'settings.update': {
    method: 'PATCH',
    path: '/api/settings',
    encode: (patch: SettingsPatch) => req({}, {}, patch),
    decode: (w) => [body<SettingsPatch>(w)],
  },
  'settings.testAi': {
    method: 'POST',
    path: '/api/settings/test-ai',
    encode: (settings?: AiSettings) => req({}, {}, settings === undefined ? {} : { settings }),
    decode: (w) => {
      const s = (w.body as { settings?: AiSettings } | undefined)?.settings;
      return s === undefined ? [] : [s];
    },
  },

  // --- anime -----------------------------------------------------------------
  'anime.listSeries': { method: 'GET', path: '/api/anime/series', encode: () => req(), decode: () => [] },
  'anime.getSeries': {
    method: 'GET',
    path: '/api/anime/series/:seriesId',
    encode: (seriesId: Id) => req({ seriesId }),
    decode: (w) => [p(w, 'seriesId')],
  },
  'anime.listEpisodes': {
    method: 'GET',
    path: '/api/anime/series/:seriesId/episodes',
    encode: (seriesId: Id) => req({ seriesId }),
    decode: (w) => [p(w, 'seriesId')],
  },
  'anime.getEpisode': {
    method: 'GET',
    path: '/api/anime/episodes/:episodeId',
    encode: (episodeId: Id) => req({ episodeId }),
    decode: (w) => [p(w, 'episodeId')],
  },
  'anime.importSeries': {
    method: 'POST',
    path: '/api/anime/series',
    encode: (request: AnimeImportRequest) => req({}, {}, request),
    decode: (w) => [body<AnimeImportRequest>(w)],
  },
  'anime.updateSeries': {
    method: 'PATCH',
    path: '/api/anime/series/:seriesId',
    encode: (seriesId: Id, patch: AnimeSeriesUpdatePatch) => req({ seriesId }, {}, patch),
    decode: (w) => [p(w, 'seriesId'), body<AnimeSeriesUpdatePatch>(w)],
  },
  'anime.removeSeries': {
    method: 'DELETE',
    path: '/api/anime/series/:seriesId',
    encode: (seriesId: Id, deleteFiles?: boolean) => req({ seriesId }, flag(deleteFiles)),
    decode: (w) => {
      const d = readFlag(w, 'deleteFiles');
      return d === undefined ? [p(w, 'seriesId')] : [p(w, 'seriesId'), d];
    },
  },
  'anime.rescanSeries': {
    method: 'POST',
    path: '/api/anime/series/:seriesId/rescan',
    encode: (seriesId: Id) => req({ seriesId }),
    decode: (w) => [p(w, 'seriesId')],
  },
  'anime.getCues': {
    method: 'GET',
    path: '/api/anime/tracks/:trackId/cues',
    encode: (trackId: Id) => req({ trackId }),
    decode: (w) => [p(w, 'trackId')],
  },
  'anime.addSubtitleTrack': {
    method: 'POST',
    path: '/api/anime/episodes/:episodeId/tracks',
    encode: (episodeId: Id, input: { readonly path?: string; readonly content?: string; readonly fileName: string; readonly language?: LanguageTag }) =>
      req({ episodeId }, {}, input),
    decode: (w) => [p(w, 'episodeId'), body<{ readonly path?: string; readonly content?: string; readonly fileName: string; readonly language?: LanguageTag }>(w)],
  },
  'anime.extractEmbeddedTrack': {
    method: 'POST',
    path: '/api/anime/episodes/:episodeId/embedded/:streamIndex',
    encode: (episodeId: Id, streamIndex: number) => req({ episodeId, streamIndex: String(streamIndex) }),
    decode: (w) => [p(w, 'episodeId'), int(p(w, 'streamIndex'), 'streamIndex')],
  },
  'anime.removeSubtitleTrack': {
    method: 'DELETE',
    path: '/api/anime/tracks/:trackId',
    encode: (trackId: Id) => req({ trackId }),
    decode: (w) => [p(w, 'trackId')],
  },
  'anime.setTrackDelay': {
    method: 'PUT',
    path: '/api/anime/tracks/:trackId/delay',
    encode: (trackId: Id, delayMs: number) => req({ trackId }, {}, { delayMs }),
    decode: (w) => [p(w, 'trackId'), Number(field<number>(w, 'delayMs'))],
  },
  'anime.setDefaultTrack': {
    method: 'PUT',
    path: '/api/anime/episodes/:episodeId/default-track',
    encode: (episodeId: Id, trackId: Id) => req({ episodeId }, {}, { trackId }),
    decode: (w) => [p(w, 'episodeId'), String(field<string>(w, 'trackId'))],
  },
  'anime.saveProgress': {
    method: 'PUT',
    path: '/api/anime/episodes/:episodeId/progress',
    encode: (episodeId: Id, progress: PlaybackProgress) => req({ episodeId }, {}, progress),
    decode: (w) => [p(w, 'episodeId'), body<PlaybackProgress>(w)],
  },
  'anime.autoFetchJimaku': {
    method: 'POST',
    path: '/api/anime/series/:seriesId/jimaku',
    encode: (seriesId: Id, options?: { readonly entryId?: number }) => req({ seriesId }, {}, options ?? {}),
    decode: (w) => {
      const entryId = (w.body as { entryId?: number } | undefined)?.entryId;
      return entryId === undefined ? [p(w, 'seriesId')] : [p(w, 'seriesId'), { entryId }];
    },
  },

  // --- manga -----------------------------------------------------------------
  'manga.listVolumes': { method: 'GET', path: '/api/manga/volumes', encode: () => req(), decode: () => [] },
  'manga.getVolume': {
    method: 'GET',
    path: '/api/manga/volumes/:volumeId',
    encode: (volumeId: Id) => req({ volumeId }),
    decode: (w) => [p(w, 'volumeId')],
  },
  'manga.importVolume': {
    method: 'POST',
    path: '/api/manga/volumes',
    encode: (request: MangaImportRequest) => req({}, {}, request),
    decode: (w) => [body<MangaImportRequest>(w)],
  },
  'manga.removeVolume': {
    method: 'DELETE',
    path: '/api/manga/volumes/:volumeId',
    encode: (volumeId: Id, deleteFiles?: boolean) => req({ volumeId }, flag(deleteFiles)),
    decode: (w) => {
      const d = readFlag(w, 'deleteFiles');
      return d === undefined ? [p(w, 'volumeId')] : [p(w, 'volumeId'), d];
    },
  },
  'manga.getPage': {
    method: 'GET',
    path: '/api/manga/volumes/:volumeId/pages/:pageIndex',
    encode: (volumeId: Id, pageIndex: number) => req({ volumeId, pageIndex: String(pageIndex) }),
    decode: (w) => [p(w, 'volumeId'), int(p(w, 'pageIndex'), 'pageIndex')],
  },
  'manga.getPages': {
    method: 'GET',
    path: '/api/manga/volumes/:volumeId/pages',
    encode: (volumeId: Id) => req({ volumeId }),
    decode: (w) => [p(w, 'volumeId')],
  },
  'manga.setReadingMode': {
    method: 'PUT',
    path: '/api/manga/volumes/:volumeId/reading-mode',
    // `undefined` (= use default) travels as JSON `null`.
    encode: (volumeId: Id, mode: MangaReadingMode | undefined) => req({ volumeId }, {}, { mode: mode ?? null }),
    decode: (w) => [p(w, 'volumeId'), field<MangaReadingMode | null>(w, 'mode') ?? undefined],
  },
  'manga.setCoverIsSingle': {
    method: 'PUT',
    path: '/api/manga/volumes/:volumeId/cover-single',
    encode: (volumeId: Id, single: boolean) => req({ volumeId }, {}, { single }),
    decode: (w) => [p(w, 'volumeId'), Boolean(field<boolean>(w, 'single'))],
  },
  'manga.saveProgress': {
    method: 'PUT',
    path: '/api/manga/volumes/:volumeId/progress',
    encode: (volumeId: Id, progress: MangaReadingProgress) => req({ volumeId }, {}, progress),
    decode: (w) => [p(w, 'volumeId'), body<MangaReadingProgress>(w)],
  },
  'manga.addBlocks': {
    method: 'POST',
    path: '/api/manga/volumes/:volumeId/pages/:pageIndex/blocks',
    encode: (volumeId: Id, pageIndex: number, blocks: readonly Omit<MangaBlock, 'index'>[]) =>
      req({ volumeId, pageIndex: String(pageIndex) }, {}, { blocks }),
    decode: (w) => [p(w, 'volumeId'), int(p(w, 'pageIndex'), 'pageIndex'), field<readonly Omit<MangaBlock, 'index'>[]>(w, 'blocks') ?? []],
  },

  // --- ai --------------------------------------------------------------------
  'ai.explain': {
    method: 'POST',
    path: '/api/ai/explain',
    encode: (request: ExplainRequest) => req({}, {}, request),
    decode: (w) => [body<ExplainRequest>(w)],
  },
  'ai.explainBatch': {
    method: 'POST',
    path: '/api/ai/explain-batch',
    encode: (requests: readonly ExplainRequest[]) => req({}, {}, { requests }),
    decode: (w) => [field<readonly ExplainRequest[]>(w, 'requests') ?? []],
  },
  'ai.getCachedExplanation': {
    method: 'POST',
    path: '/api/ai/explain/cached',
    encode: (request: ExplainRequest) => req({}, {}, request),
    decode: (w) => [body<ExplainRequest>(w)],
  },
  'ai.followUp': {
    method: 'POST',
    path: '/api/ai/follow-up',
    encode: (request: FollowUpRequest) => req({}, {}, request),
    decode: (w) => [body<FollowUpRequest>(w)],
  },
  'ai.followUpStream': {
    method: 'POST',
    path: '/api/ai/follow-up/stream',
    stream: true,
    encode: (request: FollowUpRequest) => req({}, {}, request),
    decode: (w) => [body<FollowUpRequest>(w)],
  },
  'ai.ocrBubble': {
    method: 'POST',
    path: '/api/ai/ocr-bubble',
    encode: (request: MangaBubbleOcrRequest) => req({}, {}, request),
    decode: (w) => [body<MangaBubbleOcrRequest>(w)],
  },
  'ai.pageGuide': {
    method: 'POST',
    path: '/api/ai/page-guide',
    encode: (request: MangaPageGuideRequest) => req({}, {}, request),
    decode: (w) => [body<MangaPageGuideRequest>(w)],
  },
  'ai.getThread': {
    method: 'GET',
    path: '/api/ai/threads/:explanationId',
    encode: (explanationId: Id) => req({ explanationId }),
    decode: (w) => [p(w, 'explanationId')],
  },
  'ai.clearCache': { method: 'DELETE', path: '/api/ai/cache', encode: () => req(), decode: () => [] },

  // --- downloads ---------------------------------------------------------------
  'downloads.searchNyaa': {
    method: 'POST',
    path: '/api/downloads/nyaa/search',
    encode: (query: NyaaSearchQuery) => req({}, {}, query),
    decode: (w) => [body<NyaaSearchQuery>(w)],
  },
  'downloads.searchJimaku': {
    method: 'POST',
    path: '/api/downloads/jimaku/search',
    encode: (query: JimakuSearchQuery) => req({}, {}, query),
    decode: (w) => [body<JimakuSearchQuery>(w)],
  },
  'downloads.listJimakuFiles': {
    method: 'GET',
    path: '/api/downloads/jimaku/entries/:entryId/files',
    encode: (entryId: number, episode?: number) =>
      req({ entryId: String(entryId) }, episode === undefined ? NO_QUERY : { episode: String(episode) }),
    decode: (w) => {
      const entryId = int(p(w, 'entryId'), 'entryId');
      const ep = w.query['episode'];
      return ep === undefined ? [entryId] : [entryId, int(ep, 'episode')];
    },
  },
  'downloads.browseMokuroCatalog': {
    method: 'GET',
    path: '/api/downloads/mokuro/catalog',
    encode: (url?: string) => req({}, url === undefined ? NO_QUERY : { url }),
    decode: (w) => {
      const url = w.query['url'];
      return url === undefined ? [] : [url];
    },
  },
  'downloads.list': { method: 'GET', path: '/api/downloads', encode: () => req(), decode: () => [] },
  'downloads.get': {
    method: 'GET',
    path: '/api/downloads/:taskId',
    encode: (taskId: Id) => req({ taskId }),
    decode: (w) => [p(w, 'taskId')],
  },
  'downloads.start': {
    method: 'POST',
    path: '/api/downloads',
    encode: (request: DownloadRequest) => req({}, {}, request),
    decode: (w) => [body<DownloadRequest>(w)],
  },
  'downloads.pause': {
    method: 'POST',
    path: '/api/downloads/:taskId/pause',
    encode: (taskId: Id) => req({ taskId }),
    decode: (w) => [p(w, 'taskId')],
  },
  'downloads.resume': {
    method: 'POST',
    path: '/api/downloads/:taskId/resume',
    encode: (taskId: Id) => req({ taskId }),
    decode: (w) => [p(w, 'taskId')],
  },
  'downloads.cancel': {
    method: 'POST',
    path: '/api/downloads/:taskId/cancel',
    encode: (taskId: Id) => req({ taskId }),
    decode: (w) => [p(w, 'taskId')],
  },
  'downloads.remove': {
    method: 'DELETE',
    path: '/api/downloads/:taskId',
    encode: (taskId: Id, deleteFiles?: boolean) => req({ taskId }, flag(deleteFiles)),
    decode: (w) => {
      const d = readFlag(w, 'deleteFiles');
      return d === undefined ? [p(w, 'taskId')] : [p(w, 'taskId'), d];
    },
  },
  'downloads.selectFiles': {
    method: 'PUT',
    path: '/api/downloads/:taskId/files',
    encode: (taskId: Id, fileIndexes: readonly number[]) => req({ taskId }, {}, { fileIndexes }),
    decode: (w) => [p(w, 'taskId'), field<readonly number[]>(w, 'fileIndexes') ?? []],
  },

  // --- files -------------------------------------------------------------------
  'files.listDirectory': {
    method: 'GET',
    path: '/api/files/list',
    encode: (path?: string) => req({}, path === undefined ? NO_QUERY : { path }),
    decode: (w) => {
      const path = w.query['path'];
      return path === undefined ? [] : [path];
    },
  },
  'files.openExternal': {
    method: 'POST',
    path: '/api/files/open-external',
    encode: (url: string) => req({}, {}, { url }),
    decode: (w) => [String(field<string>(w, 'url'))],
  },

  // --- dict --------------------------------------------------------------------
  'dict.list': { method: 'GET', path: '/api/dict', encode: () => req(), decode: () => [] },
  'dict.importZip': {
    method: 'POST',
    path: '/api/dict/import',
    encode: (source: DictionaryImportSource) => req({}, {}, encodeImportSource(source)),
    decode: (w) => [decodeImportSource(w)],
  },
  'dict.update': {
    method: 'PATCH',
    path: '/api/dict/:dictId',
    encode: (id: Id, patch: { enabled?: boolean; priority?: number }) => req({ dictId: id }, {}, patch),
    decode: (w) => {
      const b = (w.body ?? {}) as Record<string, unknown>;
      const patch: { enabled?: boolean; priority?: number } = {};
      if (typeof b['enabled'] === 'boolean') patch.enabled = b['enabled'];
      if (typeof b['priority'] === 'number') patch.priority = b['priority'];
      return [p(w, 'dictId'), patch];
    },
  },
  'dict.remove': {
    method: 'DELETE',
    path: '/api/dict/:dictId',
    encode: (id: Id) => req({ dictId: id }),
    decode: (w) => [p(w, 'dictId')],
  },
  'dict.enrichVocab': {
    method: 'POST',
    path: '/api/dict/enrich',
    encode: (vocab: readonly VocabEntry[]) => req({}, {}, { vocab }),
    decode: (w) => [field<readonly VocabEntry[] | undefined>(w, 'vocab') ?? []],
  },
  'dict.lookupPrefix': {
    method: 'POST',
    path: '/api/dict/lookup',
    encode: (text: string, maxLength?: number) => req({}, {}, maxLength === undefined ? { text } : { text, maxLength }),
    decode: (w) => {
      const text = String(field<string>(w, 'text') ?? '');
      const maxLength = field<number | undefined>(w, 'maxLength');
      return typeof maxLength === 'number' ? [text, maxLength] : [text];
    },
  },
};

export const ROUTE_KEYS = Object.keys(ROUTES) as RoutedMethodKey[];

/** Substitute `:param` placeholders (URI-encoded). Throws on a missing parameter. */
export function buildPath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new TypeError(`missing path parameter :${name} for ${template}`);
    return encodeURIComponent(v);
  });
}

/** Serialise a query object (`undefined` when empty). */
export function buildQuery(query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries).toString();
}

/** Re-exported so consumers can name the `AiCallOptions` stripping rule. */
export type { AiCallOptions };
