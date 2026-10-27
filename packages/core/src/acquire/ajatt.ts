/**
 * Zero-configuration Japanese anime subtitle client backed by the AJATT
 * Kitsunekko mirror (`https://subtitles.ajatt.top/` +
 * `https://raw.githubusercontent.com/Ajatt-Tools/kitsunekko-mirror/refs/heads/main/`).
 *
 * Ported from Fushi (`ajatt_catalog.dart` & `ajatt_subtitle_provider.dart`):
 * - Requires **zero API keys** and has no rate-limit quota.
 * - Exposes the same `JimakuClient` (`searchEntries`, `listFiles`) and
 *   `JimakuEntry` / `JimakuFile` types as `jimaku.ts`, using deterministic
 *   negative integer IDs (`entryId < 0`) so hosts and UI can transparently
 *   combine or fall back from `jimaku.cc` to AJATT without schema changes.
 */
import type { JimakuEntry, JimakuFile, JimakuSearchQuery } from '../types';
import { KotoriError } from '../util/errors';
import { createJimakuClient, mapJimakuFile, type JimakuClient, type JimakuRequestOptions } from './jimaku';

/** Default AJATT static catalog origin. */
export const AJATT_DEFAULT_SITE_BASE_URL = 'https://subtitles.ajatt.top';

/** Default Kitsunekko mirror raw GitHub origin. */
export const AJATT_DEFAULT_RAW_BASE_URL =
  'https://raw.githubusercontent.com/Ajatt-Tools/kitsunekko-mirror/refs/heads/main';

export type AjattEntryType = 'anime_tv' | 'anime_movie' | 'drama_tv' | 'drama_movie' | 'unsorted';

export interface AjattCatalogEntry {
  /** Deterministic negative integer ID (`< 0`) derived from `pagePath`. */
  readonly id: number;
  readonly type: AjattEntryType;
  /** Relative HTML path on `subtitles.ajatt.top`, e.g. `anime_tv/Bocchi_the_Rock!.html`. */
  readonly pagePath: string;
  /** Directory / primary display name (romaji or English). */
  readonly name: string;
  readonly englishName?: string;
  readonly japaneseName?: string;
  readonly lastModifiedAt?: number;
}

export interface AjattEntryInfo {
  readonly entryId?: number;
  readonly name: string;
  readonly entryType: string;
  readonly englishName?: string;
  readonly japaneseName?: string;
  readonly anilistId?: number;
}

const VALID_TYPES = new Set<AjattEntryType>(['anime_tv', 'anime_movie', 'drama_tv', 'drama_movie', 'unsorted']);

/**
 * Compute a deterministic negative 31-bit integer ID (`[-2147483647, -1]`) for
 * an AJATT `pagePath`. Negative IDs never collide with positive `jimaku.cc` IDs.
 */
export function ajattEntryId(pagePath: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < pagePath.length; i++) {
    h ^= pagePath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const pos = (h >>> 0) & 0x7fffffff;
  return -(pos === 0 ? 1 : pos);
}

/** True when `entryId` belongs to the AJATT provider (`< 0`). */
export function isAjattEntryId(entryId: number): boolean {
  return Number.isInteger(entryId) && entryId < 0;
}

const DROPPED_SEARCH_CHARS = new Set([
  '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  ':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|',
  '}', '~', '・', 'ー', '、', '。', '「', '」', '『', '』', '〜', '＝', '−',
  '–', '—', '\u201c', '\u201d', '\u2018', '\u2019', '…',
]);

/**
 * Normalize media titles for resilient cross-script matching (ported from Fushi's
 * `normalizeMediaSearchText`): fullwidth ASCII → halfwidth, katakana → hiragana,
 * lowercase, strip whitespace and decorative punctuation.
 */
export function normalizeSubtitleSearchText(raw: string): string {
  if (!raw) return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x3000 || code <= 0x20) continue;
    let mapped = code;
    // Fullwidth ASCII (U+FF01..U+FF5E) -> halfwidth (U+0021..U+007E)
    if (mapped >= 0xff01 && mapped <= 0xff5e) {
      mapped -= 0xfee0;
    }
    // Basic Katakana (U+30A1..U+30F6) -> Hiragana (U+3041..U+3096)
    if (mapped >= 0x30a1 && mapped <= 0x30f6) {
      mapped -= 0x60;
    }
    const normChar = String.fromCodePoint(mapped);
    if (mapped <= 0x20 || DROPPED_SEARCH_CHARS.has(normChar)) continue;
    out += normChar.toLowerCase();
  }
  return out;
}

const ENTITY_RE = /&(#?[A-Za-z0-9]+);/g;

/** Unescape common HTML entities in AJATT catalog / file tables. */
export function unescapeAjattHtml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_RE, (full, body: string) => {
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        return '\u00a0';
    }
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function extractCell(rowBody: string, className: string): string {
  const re = new RegExp(`class="${className}">([\\s\\S]*?)<\\/td>`);
  const m = re.exec(rowBody);
  return m ? stripTags(m[1] ?? '') : '';
}

const CATALOG_ROW_RE = /<tr data-timestamp="(\d+)" data-entry-type="([a-z_]+)">([\s\S]*?)<\/tr>/g;
const CATALOG_LINK_RE = /class="entry_name[^"]*"><a href="([^"]+)">([\s\S]*?)<\/a>/;
const FILE_ROW_RE =
  /<tr data-timestamp="(\d+)" data-file-size="(\d+)">[\s\S]*?data-download-url="([^"]+)" data-filename="([^"]+)"/g;

/**
 * Parse an AJATT catalog page (`index.html` or `drama.html`) into `AjattCatalogEntry[]`.
 */
export function parseAjattCatalogHtml(html: string): AjattCatalogEntry[] {
  const entries: AjattCatalogEntry[] = [];
  CATALOG_ROW_RE.lastIndex = 0;
  let row: RegExpExecArray | null;
  while ((row = CATALOG_ROW_RE.exec(html)) !== null) {
    const tsSec = Number.parseInt(row[1] ?? '0', 10);
    const rawType = (row[2] ?? '') as AjattEntryType;
    if (!VALID_TYPES.has(rawType)) continue;
    const body = row[3] ?? '';
    const link = CATALOG_LINK_RE.exec(body);
    if (!link) continue;
    const pagePath = unescapeAjattHtml(link[1] ?? '').trim();
    const name = unescapeAjattHtml(link[2] ?? '').trim();
    if (!pagePath || !name) continue;
    const englishName = unescapeAjattHtml(extractCell(body, 'english_name')).trim();
    const japaneseName = unescapeAjattHtml(extractCell(body, 'japanese_name')).trim();
    const lastModifiedAt = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : undefined;
    entries.push({
      id: ajattEntryId(pagePath),
      type: rawType,
      pagePath,
      name,
      ...(englishName ? { englishName } : {}),
      ...(japaneseName ? { japaneseName } : {}),
      ...(lastModifiedAt !== undefined ? { lastModifiedAt } : {}),
    });
  }
  return entries;
}

/**
 * Parse an AJATT entry page (`<type>/<slug>.html`) into deduplicated `JimakuFile[]`.
 */
export function parseAjattEntryPageHtml(html: string, entryId: number): JimakuFile[] {
  const byUrl = new Map<string, JimakuFile>();
  FILE_ROW_RE.lastIndex = 0;
  let row: RegExpExecArray | null;
  while ((row = FILE_ROW_RE.exec(html)) !== null) {
    const tsSec = Number.parseInt(row[1] ?? '0', 10);
    const size = Number.parseInt(row[2] ?? '0', 10);
    const url = unescapeAjattHtml(row[3] ?? '').trim();
    const name = unescapeAjattHtml(row[4] ?? '').trim();
    if (!url || !name || byUrl.has(url)) continue;
    const mapped = mapJimakuFile(
      {
        url,
        name,
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
        ...(Number.isFinite(tsSec) && tsSec > 0 ? { last_modified: new Date(tsSec * 1000).toISOString() } : {}),
      },
      entryId,
    );
    if (mapped) byUrl.set(url, mapped);
  }
  return [...byUrl.values()];
}

/** Parse `.kitsuinfo.json` from the Kitsunekko mirror repository. */
export function parseAjattEntryInfoJson(raw: string): AjattEntryInfo | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
  const rec = decoded as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const entryId = posInt(rec['entry_id']);
  const anilistId = posInt(rec['anilist_id']);
  const name = typeof rec['name'] === 'string' ? rec['name'] : '';
  const entryType = typeof rec['entry_type'] === 'string' ? rec['entry_type'] : '';
  const englishName = typeof rec['english_name'] === 'string' && rec['english_name'].trim() ? rec['english_name'].trim() : undefined;
  const japaneseName = typeof rec['japanese_name'] === 'string' && rec['japanese_name'].trim() ? rec['japanese_name'].trim() : undefined;
  return {
    name,
    entryType,
    ...(entryId !== undefined ? { entryId } : {}),
    ...(englishName !== undefined ? { englishName } : {}),
    ...(japaneseName !== undefined ? { japaneseName } : {}),
    ...(anilistId !== undefined ? { anilistId } : {}),
  };
}

/** Convert an `AjattCatalogEntry` into a standard `JimakuEntry`. */
export function toJimakuEntry(entry: AjattCatalogEntry, anilistId?: number): JimakuEntry {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.japaneseName ? { japaneseName: entry.japaneseName } : {}),
    ...(entry.englishName ? { englishName: entry.englishName } : {}),
    ...(anilistId !== undefined ? { anilistId } : {}),
    flags: {
      anime: entry.type === 'anime_tv' || entry.type === 'anime_movie' || entry.type === 'unsorted',
      unverified: false,
      external: true,
      movie: entry.type === 'anime_movie' || entry.type === 'drama_movie',
      adult: false,
    },
    ...(entry.lastModifiedAt !== undefined ? { lastModifiedAt: entry.lastModifiedAt } : {}),
  };
}

/**
 * Rank AJATT catalog entries against one or more search queries.
 * Exact normalized title hits take precedence over substring hits; ties break
 * by newest `lastModifiedAt`.
 */
export function rankAjattEntries(
  catalog: readonly AjattCatalogEntry[],
  queries: readonly string[],
  limit = 15,
): AjattCatalogEntry[] {
  const needles = [...new Set(queries.map(normalizeSubtitleSearchText).filter((q) => q.length > 0))];
  if (needles.length === 0 || limit <= 0) return [];
  const exact: AjattCatalogEntry[] = [];
  const partial: AjattCatalogEntry[] = [];

  for (const entry of catalog) {
    // Only anime entries (including unsorted legacy Kitsunekko entries)
    if (entry.type !== 'anime_tv' && entry.type !== 'anime_movie' && entry.type !== 'unsorted') continue;
    const titles = [entry.name, entry.englishName, entry.japaneseName]
      .filter((t): t is string => Boolean(t && t.trim()))
      .map(normalizeSubtitleSearchText)
      .filter((t) => t.length > 0);
    let isExact = false;
    let isPartial = false;
    for (const needle of needles) {
      for (const title of titles) {
        if (title === needle) {
          isExact = true;
        } else if (title.includes(needle) || (title.length > 2 && needle.includes(title))) {
          isPartial = true;
        }
      }
    }
    if (isExact) exact.push(entry);
    else if (isPartial) partial.push(entry);
  }

  const byNewest = (a: AjattCatalogEntry, b: AjattCatalogEntry): number =>
    (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0);
  exact.sort(byNewest);
  partial.sort(byNewest);
  const picked = exact.length > 0 ? [...exact, ...partial.slice(0, Math.max(0, limit - exact.length))] : partial;
  return picked.slice(0, limit);
}

export interface AjattClientOptions {
  readonly fetch?: typeof fetch;
  readonly siteBaseUrl?: string;
  readonly rawBaseUrl?: string;
}

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Create a zero-config AJATT subtitle client implementing `JimakuClient`.
 */
export function createAjattClient(options: AjattClientOptions = {}): JimakuClient & {
  loadCatalog(): Promise<readonly AjattCatalogEntry[]>;
} {
  const siteBase = (options.siteBaseUrl ?? AJATT_DEFAULT_SITE_BASE_URL).replace(/\/+$/, '');
  const rawBase = (options.rawBaseUrl ?? AJATT_DEFAULT_RAW_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let cachedCatalog: readonly AjattCatalogEntry[] | undefined;
  let cachedAt = 0;
  let inflightCatalog: Promise<readonly AjattCatalogEntry[]> | undefined;
  const byId = new Map<number, AjattCatalogEntry>();

  async function fetchText(url: string, req?: JimakuRequestOptions): Promise<string> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        ...(req?.signal === undefined ? {} : { signal: req.signal }),
      });
    } catch (e) {
      if (req?.signal?.aborted) {
        throw new KotoriError('cancelled', 'AJATT subtitle request cancelled', { cause: e });
      }
      throw new KotoriError('network', `AJATT request failed: ${e instanceof Error ? e.message : String(e)}`, {
        details: { url },
        cause: e,
      });
    }
    if (!res.ok) {
      if (res.status === 404) throw new KotoriError('not-found', `AJATT HTTP 404`, { details: { status: 404, url } });
      throw new KotoriError('network', `AJATT HTTP ${res.status}`, { details: { status: res.status, url } });
    }
    return res.text();
  }

  async function loadCatalog(req?: JimakuRequestOptions): Promise<readonly AjattCatalogEntry[]> {
    const now = Date.now();
    if (cachedCatalog && now - cachedAt < CATALOG_TTL_MS) return cachedCatalog;
    if (inflightCatalog) return inflightCatalog;
    const p = (async () => {
      const html = await fetchText(`${siteBase}/index.html`, req);
      const parsed = parseAjattCatalogHtml(html);
      if (parsed.length === 0) {
        throw new KotoriError('parse', 'AJATT catalog returned no entries');
      }
      byId.clear();
      for (const e of parsed) byId.set(e.id, e);
      cachedCatalog = parsed;
      cachedAt = Date.now();
      return parsed;
    })();
    inflightCatalog = p;
    try {
      return await p;
    } finally {
      inflightCatalog = undefined;
    }
  }

  async function fetchEntryAnilistId(entry: AjattCatalogEntry, req?: JimakuRequestOptions): Promise<number | undefined> {
    const url = `${rawBase}/subtitles/${entry.type}/${encodeURIComponent(entry.name)}/.kitsuinfo.json`;
    try {
      const raw = await fetchText(url, req);
      return parseAjattEntryInfoJson(raw)?.anilistId;
    } catch {
      return undefined;
    }
  }

  return {
    loadCatalog: () => loadCatalog(),
    async searchEntries(q: JimakuSearchQuery, req?: JimakuRequestOptions): Promise<JimakuEntry[]> {
      const rawQuery = (q.query ?? '').trim();
      const queries = rawQuery
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (queries.length === 0) return [];
      const catalog = await loadCatalog(req);
      const ranked = rankAjattEntries(catalog, queries, q.anilistId !== undefined ? 6 : 20);
      if (ranked.length === 0) return [];

      if (q.anilistId !== undefined) {
        const confirmed: JimakuEntry[] = [];
        const unknown: JimakuEntry[] = [];
        await Promise.all(
          ranked.slice(0, 5).map(async (entry) => {
            const remoteId = await fetchEntryAnilistId(entry, req);
            if (remoteId === q.anilistId) {
              confirmed.push(toJimakuEntry(entry, remoteId));
            } else if (remoteId === undefined) {
              unknown.push(toJimakuEntry(entry));
            }
          }),
        );
        if (confirmed.length > 0) return confirmed;
        if (unknown.length > 0) return unknown;
      }

      return ranked.map((e) => toJimakuEntry(e));
    },
    async listFiles(entryId: number, episode?: number, req?: JimakuRequestOptions): Promise<JimakuFile[]> {
      if (!byId.has(entryId)) {
        await loadCatalog(req);
      }
      const entry = byId.get(entryId);
      if (!entry) {
        throw new KotoriError('not-found', `AJATT subtitle entry ${entryId} not found`);
      }
      const pagePath = entry.pagePath.replace(/^\/+/, '');
      const html = await fetchText(`${siteBase}/${pagePath}`, req);
      const files = parseAjattEntryPageHtml(html, entryId);
      if (episode === undefined) return files;
      return files.filter((f) => f.episode === undefined || f.episode === episode);
    },
  };
}

export interface SubtitleSearchClientOptions {
  readonly fetch?: typeof fetch;
  readonly jimakuApiKey?: string | (() => string);
  readonly jimakuBaseUrl?: string;
  readonly ajattSiteBaseUrl?: string;
  readonly ajattRawBaseUrl?: string;
}

/**
 * Create a unified Japanese subtitle client that queries `jimaku.cc` when an API key
 * is configured and automatically falls back to the zero-config AJATT Kitsunekko
 * mirror (`subtitles.ajatt.top`) when no key is set or when Jimaku returns no entries.
 */
export function createSubtitleSearchClient(options: SubtitleSearchClientOptions): JimakuClient {
  const ajatt = createAjattClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.ajattSiteBaseUrl ? { siteBaseUrl: options.ajattSiteBaseUrl } : {}),
    ...(options.ajattRawBaseUrl ? { rawBaseUrl: options.ajattRawBaseUrl } : {}),
  });
  const resolveJimaku = (): JimakuClient | undefined => {
    const rawKey = typeof options.jimakuApiKey === 'function' ? options.jimakuApiKey() : (options.jimakuApiKey ?? '');
    const apiKey = rawKey.trim();
    if (apiKey.length === 0) return undefined;
    return createJimakuClient({
      apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.jimakuBaseUrl ? { baseUrl: options.jimakuBaseUrl } : {}),
    });
  };

  return {
    async searchEntries(q: JimakuSearchQuery, req?: JimakuRequestOptions): Promise<JimakuEntry[]> {
      const jimaku = resolveJimaku();
      if (jimaku) {
        try {
          const primaryQuery = q.query?.includes('|') ? q.query.split('|')[0]?.trim() : q.query;
          const res = await jimaku.searchEntries(
            {
              ...(primaryQuery ? { query: primaryQuery } : {}),
              ...(q.anilistId !== undefined ? { anilistId: q.anilistId } : {}),
              ...(q.episode !== undefined ? { episode: q.episode } : {}),
            },
            req,
          );
          if (res.length > 0) return res;
        } catch (err) {
          if (req?.signal?.aborted) throw err;
          // Fall back to zero-config AJATT catalog on Jimaku error or empty result when query is present
          if (!q.query?.trim()) throw err;
        }
      }
      if (!q.query?.trim()) {
        if (!jimaku) throw new KotoriError('invalid-argument', 'Jimaku API key is not configured');
        return [];
      }
      try {
        return await ajatt.searchEntries(q, req);
      } catch (err) {
        if (!jimaku) {
          throw new KotoriError(
            'invalid-argument',
            `Jimaku API key is not configured (and zero-config AJATT mirror failed: ${err instanceof Error ? err.message : String(err)})`,
            { cause: err },
          );
        }
        throw err;
      }
    },
    async listFiles(entryId: number, episode?: number, req?: JimakuRequestOptions): Promise<JimakuFile[]> {
      if (isAjattEntryId(entryId)) {
        return ajatt.listFiles(entryId, episode, req);
      }
      const jimaku = resolveJimaku();
      if (!jimaku) {
        throw new KotoriError('invalid-argument', 'Jimaku API key is not configured');
      }
      return jimaku.listFiles(entryId, episode, req);
    },
  };
}
