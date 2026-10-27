/**
 * mokuro.moe (and any nginx / caddy / apache autoindex) directory listing
 * parser. Pairs `X.mokuro` with its page images (`X.zip`, `X.cbz` or `X/`).
 *
 * Regex-based (no DOMParser) so it runs in every host runtime.
 */
import type { MokuroCatalogEntry, MokuroCatalogListing, MokuroCatalogVolume } from '../types';
import { compareNatural } from '../util/natural-sort';
import { parseNyaaSize } from './nyaa';
import { decodeXmlEntities } from './xml';

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** `decodeURIComponent` that never throws. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Human-readable binary size (`793.3 KiB`). */
function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** Ensure a listing URL ends with `/` so relative hrefs resolve inside it. */
function normaliseListingUrl(url: string): URL {
  const u = new URL(url);
  u.hash = '';
  u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

/**
 * Normalise a catalog target URL: `mokuro.moe` root / legacy `/manga/` / `/catalog/`
 * paths map to the Mokuro Bunko JSON endpoint (`/catalog/api/library`), while
 * `/catalog/api/...` and custom self-hosted autoindex URLs are preserved.
 */
export function resolveMokuroCatalogUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    if (host === 'mokuro.moe' || host === 'www.mokuro.moe' || host === 'catalog.mokuro.moe') {
      const cleanPath = u.pathname.replace(/\/+$/, '');
      if (cleanPath === '' || cleanPath === '/manga' || cleanPath === '/catalog') {
        return `https://mokuro.moe/catalog/api/library`;
      }
    }
    return u.href;
  } catch {
    return url;
  }
}

interface MokuroApiSeriesItem {
  readonly name?: unknown;
  readonly cover?: unknown;
  readonly volume_count?: unknown;
  readonly latest_volume_modified?: unknown;
  readonly total_pages?: unknown;
  readonly total_chars?: unknown;
  readonly titles?: {
    readonly native?: unknown;
    readonly romaji?: unknown;
    readonly english?: unknown;
  };
  readonly community?: {
    readonly score?: unknown;
    readonly genres?: unknown;
    readonly tags?: unknown;
  };
}

interface MokuroApiVolumeItem {
  readonly name?: unknown;
  readonly cover?: unknown;
  readonly page_count?: unknown;
  readonly ocr_pending?: unknown;
}

function resolveMokuroCoverUrl(origin: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const encodedPath = trimmed
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return encodedPath ? `${origin}/mokuro-reader/${encodedPath}` : undefined;
}

function stringList(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}

function tryParseMokuroBunkoJson(raw: string, url: string): MokuroCatalogListing | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const u = new URL(url);
  const origin = u.origin;

  if (Array.isArray(obj['series'])) {
    const entries: MokuroCatalogEntry[] = [];
    for (const item of obj['series'] as MokuroApiSeriesItem[]) {
      if (typeof item !== 'object' || item === null) continue;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      const nativeTitle = typeof item.titles?.native === 'string' && item.titles.native.trim() ? item.titles.native.trim() : undefined;
      const romajiTitle = typeof item.titles?.romaji === 'string' && item.titles.romaji.trim() ? item.titles.romaji.trim() : undefined;
      const englishTitle = typeof item.titles?.english === 'string' && item.titles.english.trim() ? item.titles.english.trim() : undefined;
      const volumeCount = typeof item.volume_count === 'number' && item.volume_count > 0 ? item.volume_count : undefined;
      const totalPages = typeof item.total_pages === 'number' && item.total_pages > 0 ? item.total_pages : undefined;
      const totalChars = typeof item.total_chars === 'number' && item.total_chars > 0 ? item.total_chars : undefined;
      const score = typeof item.community?.score === 'number' && item.community.score > 0 ? Math.round(item.community.score) : undefined;
      const genres = stringList(item.community?.genres);
      const tags = stringList(item.community?.tags);
      const coverUrl = resolveMokuroCoverUrl(origin, item.cover);
      const volCount = volumeCount !== undefined ? `${volumeCount} vol` : undefined;
      const subtitleParts: string[] = [];
      if (nativeTitle && nativeTitle !== name) subtitleParts.push(nativeTitle);
      if (englishTitle && englishTitle !== name && englishTitle !== nativeTitle) subtitleParts.push(englishTitle);
      if (volCount) subtitleParts.push(volCount);
      const modifiedAt =
        typeof item.latest_volume_modified === 'number' && Number.isFinite(item.latest_volume_modified)
          ? Math.round(item.latest_volume_modified * 1000)
          : undefined;
      entries.push({
        kind: 'dir',
        name,
        url: `${origin}/catalog/api/series?name=${encodeURIComponent(name)}`,
        ...(subtitleParts.length > 0 ? { sizeText: subtitleParts.join(' · ') } : {}),
        ...(modifiedAt !== undefined ? { modifiedAt } : {}),
        ...(coverUrl !== undefined ? { coverUrl } : {}),
        ...(nativeTitle !== undefined ? { nativeTitle } : {}),
        ...(romajiTitle !== undefined ? { romajiTitle } : {}),
        ...(englishTitle !== undefined ? { englishTitle } : {}),
        ...(volumeCount !== undefined ? { volumeCount } : {}),
        ...(totalPages !== undefined ? { totalPages } : {}),
        ...(totalChars !== undefined ? { totalChars } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(genres !== undefined ? { genres } : {}),
        ...(tags !== undefined ? { tags } : {}),
        isMokuro: false,
        isImageArchive: false,
      });
    }
    entries.sort((a, b) => compareNatural(a.name, b.name));
    return { url: `${origin}/catalog/api/library`, path: [], entries, volumes: [] };
  }

  if (Array.isArray(obj['volumes'])) {
    const seriesName =
      typeof obj['name'] === 'string' && obj['name'].trim() !== ''
        ? obj['name'].trim()
        : (u.searchParams.get('name') ?? 'Series');
    const seriesCoverUrl = resolveMokuroCoverUrl(origin, obj['cover']);
    const volumes: MokuroCatalogVolume[] = [];
    for (const v of obj['volumes'] as MokuroApiVolumeItem[]) {
      if (typeof v !== 'object' || v === null) continue;
      const volName = typeof v.name === 'string' ? v.name.trim() : '';
      if (!volName || v.ocr_pending === true) continue;
      const coverUrl = resolveMokuroCoverUrl(origin, v.cover) ?? seriesCoverUrl;
      const pageCount = typeof v.page_count === 'number' && v.page_count > 0 ? v.page_count : undefined;
      volumes.push({
        name: volName,
        mokuroUrl: `${origin}/mokuro-reader/${encodeURIComponent(seriesName)}/${encodeURIComponent(volName)}.mokuro`,
        imagesUrl: `${origin}/mokuro-reader/${encodeURIComponent(seriesName)}/${encodeURIComponent(volName)}.cbz`,
        imagesKind: 'archive',
        ...(coverUrl !== undefined ? { coverUrl } : {}),
        ...(pageCount !== undefined ? { pageCount } : {}),
      });
    }
    volumes.sort((a, b) => compareNatural(a.name, b.name));
    return {
      url: u.href,
      path: [seriesName],
      entries: [],
      volumes,
      ...(seriesCoverUrl !== undefined ? { coverUrl: seriesCoverUrl } : {}),
    };
  }

  return undefined;
}

interface RowMeta {
  sizeText?: string;
  sizeBytes?: number;
  modifiedAt?: number;
}

/**
 * Extract size / mtime from the markup that follows an anchor up to the next
 * row. Handles caddy (`data-order`, `sizebar-text`, `<time datetime>`), nginx
 * (`14-Mar-2024 10:21   812345`) and apache (`2024-03-14 10:21  50M`).
 */
function parseRowMeta(context: string): RowMeta {
  const meta: RowMeta = {};
  const order = /data-order\s*=\s*"(-?\d+)"/.exec(context);
  if (order && Number(order[1]) >= 0) meta.sizeBytes = Number(order[1]);
  const sizebar = /class\s*=\s*"sizebar-text"[^>]*>([^<]*)</.exec(context);
  if (sizebar && (sizebar[1] as string).trim() !== '') meta.sizeText = decodeXmlEntities((sizebar[1] as string).trim());
  const time = /<time[^>]*datetime\s*=\s*"([^"]+)"/.exec(context);
  if (time) {
    const t = Date.parse(time[1] as string);
    if (Number.isFinite(t)) meta.modifiedAt = t;
  }

  const text = decodeXmlEntities(context.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
  // nginx: 14-Mar-2024 10:21 812345
  const ng = /(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? (\S+)/.exec(text);
  // apache: 2024-03-14 10:21 50M
  const ap = /(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))? (\S+)/.exec(text);
  let sizeToken: string | undefined;
  if (ng) {
    const month = MONTHS[(ng[2] as string).toLowerCase()];
    if (month !== undefined && meta.modifiedAt === undefined) {
      meta.modifiedAt = Date.UTC(Number(ng[3]), month, Number(ng[1]), Number(ng[4]), Number(ng[5]), Number(ng[6] ?? 0));
    }
    sizeToken = ng[7];
  } else if (ap) {
    if (meta.modifiedAt === undefined) {
      meta.modifiedAt = Date.UTC(Number(ap[1]), Number(ap[2]) - 1, Number(ap[3]), Number(ap[4]), Number(ap[5]), Number(ap[6] ?? 0));
    }
    sizeToken = ap[7];
  }
  if (sizeToken !== undefined && sizeToken !== '-' && meta.sizeBytes === undefined) {
    const bytes = parseNyaaSize(sizeToken);
    if (bytes !== undefined) {
      meta.sizeBytes = bytes;
      meta.sizeText ??= /^\d+$/.test(sizeToken) ? formatBytes(bytes) : sizeToken;
    }
  }
  if (meta.sizeBytes !== undefined && meta.sizeText === undefined) meta.sizeText = formatBytes(meta.sizeBytes);
  return meta;
}

/**
 * Parse an autoindex HTML page (nginx `autoindex`, caddy `file_server
 * browse`, apache `mod_autoindex`) into catalog entries and importable
 * volumes.
 *
 * Only direct children of `url` are kept (parent links, breadcrumbs, sort
 * links and external links are dropped). Names come from the decoded `href`
 * (nginx truncates link text). Directory URLs keep their trailing `/`.
 * Entries are sorted directories-first, then naturally by name.
 *
 * @param html The listing page body.
 * @param url The URL the page was fetched from (used to resolve hrefs).
 */
export function parseMokuroMoeListing(html: string, url: string): MokuroCatalogListing {
  const jsonListing = tryParseMokuroBunkoJson(html, url);
  if (jsonListing) return jsonListing;
  const base = normaliseListingUrl(url);
  const baseDir = safeDecode(base.pathname);
  const path = baseDir.split('/').filter((s) => s !== '');
  const entries: MokuroCatalogEntry[] = [];
  const seen = new Set<string>();

  const anchorRe = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>[\s\S]*?<\/a\s*>/gi;
  const anchors: { href: string; end: number; start: number }[] = [];
  for (let m = anchorRe.exec(html); m; m = anchorRe.exec(html)) {
    anchors.push({ href: decodeXmlEntities(m[1] ?? m[2] ?? m[3] ?? ''), start: m.index, end: m.index + m[0].length });
  }

  anchors.forEach((a, i) => {
    const href = a.href.trim();
    if (href === '' || href.startsWith('?') || href.startsWith('#') || /^(?:mailto|javascript):/i.test(href)) return;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      return;
    }
    if (resolved.origin !== base.origin || resolved.search !== '' || resolved.hash !== '') return;
    const childPath = safeDecode(resolved.pathname);
    if (!childPath.startsWith(baseDir) || childPath.length <= baseDir.length) return;
    const rest = childPath.slice(baseDir.length);
    const isDir = rest.endsWith('/');
    const name = isDir ? rest.slice(0, -1) : rest;
    if (name === '' || name.includes('/') || name === '.' || name === '..') return;
    if (seen.has(resolved.href)) return;
    seen.add(resolved.href);

    // Row context: markup after this anchor up to the next anchor / end of row.
    const nextStart = anchors[i + 1]?.start ?? html.length;
    let context = html.slice(a.end, nextStart);
    const rowEnd = context.search(/<\/tr\s*>/i);
    if (rowEnd >= 0) context = context.slice(0, rowEnd);
    const rowMeta = parseRowMeta(context);
    // Directories have no meaningful size (`-` / `&mdash;`); keep only the mtime.
    const meta: RowMeta = isDir ? (rowMeta.modifiedAt === undefined ? {} : { modifiedAt: rowMeta.modifiedAt }) : rowMeta;

    const lower = name.toLowerCase();
    const entry: MokuroCatalogEntry = {
      kind: isDir ? 'dir' : 'file',
      name,
      url: resolved.href,
      ...(meta.sizeText === undefined ? {} : { sizeText: meta.sizeText }),
      ...(meta.sizeBytes === undefined ? {} : { sizeBytes: meta.sizeBytes }),
      ...(meta.modifiedAt === undefined ? {} : { modifiedAt: meta.modifiedAt }),
      isMokuro: !isDir && lower.endsWith('.mokuro'),
      isImageArchive: !isDir && (lower.endsWith('.zip') || lower.endsWith('.cbz')),
    };
    entries.push(entry);
  });

  entries.sort((x, y) => (x.kind === y.kind ? compareNatural(x.name, y.name) : x.kind === 'dir' ? -1 : 1));
  return { url: base.href, path, entries, volumes: pairVolumes(entries) };
}

/**
 * Pair each `X.mokuro` with `X.zip` > `X.cbz` > `X/` (names compared after
 * NFC normalisation, extensions case-insensitively). `sizeBytes` is the
 * archive + `.mokuro` size when both are known; omitted for directories.
 */
function pairVolumes(entries: readonly MokuroCatalogEntry[]): MokuroCatalogVolume[] {
  const files = new Map<string, MokuroCatalogEntry>();
  const dirs = new Map<string, MokuroCatalogEntry>();
  for (const e of entries) {
    const key = e.name.normalize('NFC');
    if (e.kind === 'dir') dirs.set(key, e);
    else files.set(key.replace(/\.(zip|cbz|mokuro)$/i, (ext) => ext.toLowerCase()), e);
  }
  const volumes: MokuroCatalogVolume[] = [];
  for (const e of entries) {
    if (!e.isMokuro) continue;
    const stem = e.name.normalize('NFC').replace(/\.mokuro$/i, '');
    const archive = files.get(`${stem}.zip`) ?? files.get(`${stem}.cbz`);
    if (archive) {
      const total = archive.sizeBytes !== undefined && e.sizeBytes !== undefined ? archive.sizeBytes + e.sizeBytes : undefined;
      volumes.push({
        name: stem,
        mokuroUrl: e.url,
        imagesUrl: archive.url,
        imagesKind: 'archive',
        ...(total === undefined ? {} : { sizeBytes: total }),
      });
      continue;
    }
    const dir = dirs.get(stem);
    if (dir) volumes.push({ name: stem, mokuroUrl: e.url, imagesUrl: dir.url, imagesKind: 'dir' });
  }
  return volumes.sort((a, b) => compareNatural(a.name, b.name));
}
