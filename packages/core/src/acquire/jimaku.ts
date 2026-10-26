/**
 * jimaku.cc API client (Japanese subtitle archive) plus pure mappers and the
 * episode ⇄ file matcher used by `autoFetchJimaku`.
 *
 * API reference: `GET /api/entries/search?query=&anilist_id=`,
 * `GET /api/entries/{id}/files?episode=`, header `Authorization: <apiKey>`.
 */
import type { AnimeEpisode, ArchiveFormat, Id, JimakuEntry, JimakuFile, JimakuSearchQuery } from '../types';
import { parseEpisodeName } from '../subtitle/episode-name';
import { KotoriError } from '../util/errors';
import { compareNatural } from '../util/natural-sort';

/** Default Jimaku origin. */
export const JIMAKU_DEFAULT_BASE_URL = 'https://jimaku.cc';

/** Dependencies / configuration for `createJimakuClient`. */
export interface JimakuClientOptions {
  /** Injected fetch (hosts may proxy); defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** jimaku.cc API key, sent verbatim in the `Authorization` header. */
  readonly apiKey: string;
  /** Origin override; default `https://jimaku.cc`. */
  readonly baseUrl?: string;
}

/** Per-call options. */
export interface JimakuRequestOptions {
  readonly signal?: AbortSignal;
}

/** Jimaku API client. All methods reject with `KotoriError`. */
export interface JimakuClient {
  /** Search entries by title and/or AniList id. Resolves `[]` when neither is given. */
  searchEntries(q: JimakuSearchQuery, options?: JimakuRequestOptions): Promise<JimakuEntry[]>;
  /** List the files of an entry, optionally filtered server-side by episode. */
  listFiles(entryId: number, episode?: number, options?: JimakuRequestOptions): Promise<JimakuFile[]>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function optNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optTime(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Map a raw Jimaku entry (`{ id, name, japanese_name, english_name,
 * anilist_id, tmdb_id, flags, last_modified }`) to a `JimakuEntry`.
 *
 * @returns `undefined` when `id`/`name` are missing or malformed.
 */
export function mapJimakuEntry(raw: unknown): JimakuEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const id = optNumber(raw['id']);
  const name = optString(raw['name']);
  if (id === undefined || name === undefined) return undefined;
  const flags = isRecord(raw['flags']) ? raw['flags'] : {};
  const japaneseName = optString(raw['japanese_name']);
  const englishName = optString(raw['english_name']);
  const anilistId = optNumber(raw['anilist_id']);
  const tmdbId = optString(raw['tmdb_id']);
  const lastModifiedAt = optTime(raw['last_modified']);
  return {
    id,
    name,
    ...(japaneseName === undefined ? {} : { japaneseName }),
    ...(englishName === undefined ? {} : { englishName }),
    ...(anilistId === undefined ? {} : { anilistId }),
    ...(tmdbId === undefined ? {} : { tmdbId }),
    flags: {
      anime: flags['anime'] !== false,
      unverified: flags['unverified'] === true,
      external: flags['external'] === true,
      movie: flags['movie'] === true,
      adult: flags['adult'] === true,
    },
    ...(lastModifiedAt === undefined ? {} : { lastModifiedAt }),
  };
}

const TEXT_SUBTITLE_EXTENSIONS = new Set(['srt', 'ass', 'vtt']);
const ARCHIVE_EXTENSIONS = new Set<ArchiveFormat>(['zip', 'rar', '7z']);

/**
 * Map a raw Jimaku file (`{ url, name, size, last_modified }`) to a
 * `JimakuFile`, deriving `extension`, `isTextSubtitle`, `archiveFormat` and
 * the episode number (via `parseEpisodeName`).
 *
 * @returns `undefined` when `url`/`name` are missing.
 */
export function mapJimakuFile(raw: unknown, entryId: number): JimakuFile | undefined {
  if (!isRecord(raw)) return undefined;
  const url = optString(raw['url']);
  const name = optString(raw['name']);
  if (url === undefined || name === undefined) return undefined;
  const extMatch = /\.([A-Za-z0-9]+)$/.exec(name);
  const extension = extMatch ? (extMatch[1] as string).toLowerCase() : '';
  const sizeBytes = optNumber(raw['size']);
  const lastModifiedAt = optTime(raw['last_modified']);
  const archiveFormat = ARCHIVE_EXTENSIONS.has(extension as ArchiveFormat) ? (extension as ArchiveFormat) : undefined;
  const episode = parseEpisodeName(name).episode;
  return {
    entryId,
    name,
    url,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(lastModifiedAt === undefined ? {} : { lastModifiedAt }),
    extension,
    isTextSubtitle: TEXT_SUBTITLE_EXTENSIONS.has(extension),
    ...(archiveFormat === undefined ? {} : { archiveFormat }),
    ...(episode === undefined || archiveFormat !== undefined ? {} : { episode }),
  };
}

/** Parse `Retry-After` (seconds or HTTP date) / `x-ratelimit-reset-after` (seconds) into ms. */
function retryAfterMs(headers: Headers, now: number): number | undefined {
  const reset = headers.get('x-ratelimit-reset-after');
  if (reset !== null && Number.isFinite(Number.parseFloat(reset))) return Math.ceil(Number.parseFloat(reset) * 1000);
  const ra = headers.get('retry-after');
  if (ra === null) return undefined;
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(ra)) return Math.ceil(Number.parseFloat(ra) * 1000);
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/**
 * Create a Jimaku API client.
 *
 * Errors: missing API key → `invalid-argument`; HTTP 404 → `not-found`;
 * 429 → `network` with `details: { status: 429, retryAfterMs }`; other
 * non-2xx (incl. 401/403) → `network` with `details.status`; aborted →
 * `cancelled`; transport failure → `network`; non-JSON body → `parse`.
 */
export function createJimakuClient(options: JimakuClientOptions): JimakuClient {
  const base = (options.baseUrl ?? JIMAKU_DEFAULT_BASE_URL).replace(/\/+$/, '');

  /** GET `{base}{path}` and return the decoded JSON body, mapping failures to KotoriError. */
  async function getJson(path: string, req: JimakuRequestOptions | undefined): Promise<unknown> {
    if (options.apiKey.trim() === '') {
      throw new KotoriError('invalid-argument', 'Jimaku API key is not configured');
    }
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const url = `${base}${path}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: { Authorization: options.apiKey, Accept: 'application/json' },
        ...(req?.signal === undefined ? {} : { signal: req.signal }),
      });
    } catch (e) {
      if (isAbortError(e) || req?.signal?.aborted === true) {
        throw new KotoriError('cancelled', 'Jimaku request cancelled', { cause: e });
      }
      throw new KotoriError('network', `Jimaku request failed: ${e instanceof Error ? e.message : String(e)}`, {
        details: { url },
        cause: e,
      });
    }
    if (!res.ok) {
      let message = `Jimaku HTTP ${res.status}`;
      try {
        const body: unknown = await res.json();
        if (isRecord(body) && typeof body['error'] === 'string') message += `: ${body['error']}`;
      } catch {
        // body is optional
      }
      if (res.status === 404) throw new KotoriError('not-found', message, { details: { status: 404, url } });
      if (res.status === 429) {
        const wait = retryAfterMs(res.headers, Date.now());
        throw new KotoriError('network', message, {
          details: wait === undefined ? { status: 429, url } : { status: 429, retryAfterMs: wait, url },
        });
      }
      throw new KotoriError('network', message, { details: { status: res.status, url } });
    }
    try {
      return (await res.json()) as unknown;
    } catch (e) {
      throw new KotoriError('parse', 'Jimaku returned invalid JSON', { details: { url }, cause: e });
    }
  }

  return {
    async searchEntries(q, req) {
      const params: string[] = [];
      const query = q.query?.trim();
      if (query) params.push(`query=${encodeURIComponent(query)}`);
      if (q.anilistId !== undefined) params.push(`anilist_id=${encodeURIComponent(String(q.anilistId))}`);
      if (params.length === 0) return [];
      const body = await getJson(`/api/entries/search?${params.join('&')}`, req);
      if (!Array.isArray(body)) throw new KotoriError('parse', 'Jimaku search did not return an array');
      return body.map(mapJimakuEntry).filter((e): e is JimakuEntry => e !== undefined);
    },
    async listFiles(entryId, episode, req) {
      const qs = episode === undefined ? '' : `?episode=${encodeURIComponent(String(episode))}`;
      const body = await getJson(`/api/entries/${encodeURIComponent(String(entryId))}/files${qs}`, req);
      if (!Array.isArray(body)) throw new KotoriError('parse', 'Jimaku files did not return an array');
      return body.map((f) => mapJimakuFile(f, entryId)).filter((f): f is JimakuFile => f !== undefined);
    },
  };
}

const FORMAT_RANK: Readonly<Record<string, number>> = { ass: 0, srt: 1, vtt: 2 };

/** Preference order: `.ass` > `.srt` > `.vtt`, then newest `lastModifiedAt`, then natural name order. */
function compareCandidates(a: JimakuFile, b: JimakuFile): number {
  const ra = FORMAT_RANK[a.extension] ?? 9;
  const rb = FORMAT_RANK[b.extension] ?? 9;
  if (ra !== rb) return ra - rb;
  const ta = a.lastModifiedAt ?? -Infinity;
  const tb = b.lastModifiedAt ?? -Infinity;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return compareNatural(a.name, b.name);
}

/**
 * Pick the best Jimaku file for each episode.
 *
 * Matches `JimakuFile.episode` against `episode.parsedName.episode` (text
 * subtitles only; archives are ignored). When both the file name and the
 * episode carry a season and they differ, the file is skipped. Among the
 * candidates `.ass` beats `.srt` beats `.vtt`, then the newest wins.
 *
 * @returns Map of `episode.id` → chosen file; episodes without a match are absent.
 */
export function matchJimakuFilesToEpisodes(
  files: readonly JimakuFile[],
  episodes: readonly Pick<AnimeEpisode, 'id' | 'parsedName'>[],
): Map<Id, JimakuFile> {
  const byEpisode = new Map<number, { file: JimakuFile; season: number | undefined }[]>();
  for (const file of files) {
    if (!file.isTextSubtitle || file.episode === undefined) continue;
    const list = byEpisode.get(file.episode) ?? [];
    list.push({ file, season: parseEpisodeName(file.name).season });
    byEpisode.set(file.episode, list);
  }
  const out = new Map<Id, JimakuFile>();
  for (const ep of episodes) {
    const n = ep.parsedName.episode;
    if (n === undefined) continue;
    const season = ep.parsedName.season;
    const candidates = (byEpisode.get(n) ?? [])
      .filter((c) => season === undefined || c.season === undefined || c.season === season)
      .map((c) => c.file)
      .sort(compareCandidates);
    const best = candidates[0];
    if (best !== undefined) out.set(ep.id, best);
  }
  return out;
}
