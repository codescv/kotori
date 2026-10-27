/**
 * Lightweight, zero-key AniList GraphQL metadata & cover art resolver for
 * Anime (Nyaa) and Subtitle (Jimaku) search results.
 *
 * Uses in-memory caching and fails silently when offline or in unit tests.
 */

export interface AniListMediaInfo {
  readonly id: number;
  readonly coverUrl?: string;
  readonly bannerUrl?: string;
  readonly nativeTitle?: string;
  readonly romajiTitle?: string;
  readonly englishTitle?: string;
  readonly score?: number;
  readonly episodes?: number;
  readonly format?: string;
  readonly seasonYear?: number;
  readonly genres?: readonly string[];
}

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const byIdCache = new Map<number, AniListMediaInfo>();
const bySearchCache = new Map<string, AniListMediaInfo | null>();

const MEDIA_FIELDS = `
  id
  title { native romaji english }
  coverImage { large medium }
  bannerImage
  averageScore
  episodes
  format
  seasonYear
  genres
`;

function mapMedia(raw: unknown): AniListMediaInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'number' ? r['id'] : undefined;
  if (id === undefined) return undefined;
  const title = (r['title'] as Record<string, unknown> | undefined) ?? {};
  const cover = (r['coverImage'] as Record<string, unknown> | undefined) ?? {};
  const coverUrl =
    (typeof cover['large'] === 'string' && cover['large']) ||
    (typeof cover['medium'] === 'string' && cover['medium']) ||
    undefined;
  const bannerUrl = typeof r['bannerImage'] === 'string' && r['bannerImage'] ? r['bannerImage'] : undefined;
  const nativeTitle = typeof title['native'] === 'string' && title['native'].trim() ? title['native'].trim() : undefined;
  const romajiTitle = typeof title['romaji'] === 'string' && title['romaji'].trim() ? title['romaji'].trim() : undefined;
  const englishTitle = typeof title['english'] === 'string' && title['english'].trim() ? title['english'].trim() : undefined;
  const score = typeof r['averageScore'] === 'number' && r['averageScore'] > 0 ? Math.round(r['averageScore']) : undefined;
  const episodes = typeof r['episodes'] === 'number' && r['episodes'] > 0 ? r['episodes'] : undefined;
  const format = typeof r['format'] === 'string' && r['format'] ? r['format'] : undefined;
  const seasonYear = typeof r['seasonYear'] === 'number' && r['seasonYear'] > 0 ? r['seasonYear'] : undefined;
  const genres = Array.isArray(r['genres'])
    ? r['genres'].filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    : undefined;

  const info: AniListMediaInfo = {
    id,
    ...(coverUrl !== undefined ? { coverUrl } : {}),
    ...(bannerUrl !== undefined ? { bannerUrl } : {}),
    ...(nativeTitle !== undefined ? { nativeTitle } : {}),
    ...(romajiTitle !== undefined ? { romajiTitle } : {}),
    ...(englishTitle !== undefined ? { englishTitle } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(episodes !== undefined ? { episodes } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(seasonYear !== undefined ? { seasonYear } : {}),
    ...(genres && genres.length > 0 ? { genres } : {}),
  };
  byIdCache.set(id, info);
  return info;
}

/** Clean up release tags/resolutions from a Nyaa search query before querying AniList. */
export function cleanSearchQueryForAniList(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(?:1080p|720p|2160p|4K|HEVC|x265|x264|10bit|BD|BDRip|WEB-?DL|WEBRip|FLAC|AAC|RAW|Batch|S\d+E?\d*)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch top matching Anime metadata from AniList for a search query. */
export async function fetchAniListBySearch(query: string): Promise<AniListMediaInfo | undefined> {
  const cleaned = cleanSearchQueryForAniList(query);
  if (cleaned.length < 2 || typeof fetch !== 'function') return undefined;
  const key = cleaned.toLowerCase();
  if (bySearchCache.has(key)) return bySearchCache.get(key) ?? undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: `query ($search: String) { Page(perPage: 1) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} } } }`,
        variables: { search: cleaned },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { Page?: { media?: unknown[] } } };
    const first = json?.data?.Page?.media?.[0];
    const mapped = mapMedia(first);
    bySearchCache.set(key, mapped ?? null);
    return mapped;
  } catch {
    return undefined;
  }
}

/** Batch-fetch Anime metadata from AniList for a list of `anilistId`s (e.g. from Jimaku entries). */
export async function fetchAniListByIds(ids: readonly number[]): Promise<ReadonlyMap<number, AniListMediaInfo>> {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  const missing = unique.filter((id) => !byIdCache.has(id));
  if (missing.length > 0 && typeof fetch === 'function') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(ANILIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`,
          variables: { ids: missing.slice(0, 50) },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as { data?: { Page?: { media?: unknown[] } } };
        for (const item of json?.data?.Page?.media ?? []) {
          mapMedia(item);
        }
      }
    } catch {
      // Ignore network/test errors; fallback to existing entry fields.
    }
  }
  const out = new Map<number, AniListMediaInfo>();
  for (const id of unique) {
    const cached = byIdCache.get(id);
    if (cached) out.set(id, cached);
  }
  return out;
}
