/**
 * nyaa.si HTML & RSS search: URL builders, tolerant HTML/RSS parsers, size
 * parser, magnet synthesis with Nyaa's default tracker list, and deterministic
 * multi-query merging/sorting.
 *
 * All parsers are hand-rolled scanners (no DOMParser) so they run unchanged in
 * Node, browsers, and the Android WebView.
 */
import type { NyaaSearchQuery, NyaaTorrentItem } from '../types';
import { parseEpisodeName } from '../subtitle/episode-name';
import { buildMagnet, normaliseInfoHash, parseMagnet } from './magnet';
import { decodeXmlEntities } from './xml';

/** Default nyaa.si mirror. */
export const NYAA_DEFAULT_BASE_URL = 'https://nyaa.si';

/** Trackers nyaa.si itself puts into its magnet links. */
export const NYAA_TRACKERS: readonly string[] = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

const FILTER_PARAM: Readonly<Record<NonNullable<NyaaSearchQuery['filter']>, string>> = {
  none: '0',
  'no-remakes': '1',
  'trusted-only': '2',
};

const SORT_PARAM: Readonly<Record<NonNullable<NyaaSearchQuery['sort']>, string>> = {
  seeders: 'seeders',
  date: 'id',
  size: 'size',
  downloads: 'downloads',
};

/**
 * Build the RSS search URL:
 * `{base}/?page=rss&q=…&c=1_4&f=0&s=seeders&o=desc[&p=N]`.
 *
 * Defaults: category `1_4` (Anime – Raw), filter `none`, sort `seeders`.
 */
export function buildNyaaRssUrl(q: NyaaSearchQuery, base: string = NYAA_DEFAULT_BASE_URL): string {
  const root = base.replace(/\/+$/, '');
  const params = [
    'page=rss',
    `q=${encodeURIComponent(q.query.trim())}`,
    `c=${encodeURIComponent(q.category ?? '1_4')}`,
    `f=${FILTER_PARAM[q.filter ?? 'none']}`,
    `s=${SORT_PARAM[q.sort ?? 'seeders']}`,
    'o=desc',
  ];
  if (q.page !== undefined && q.page > 1) params.push(`p=${Math.floor(q.page)}`);
  return `${root}/?${params.join('&')}`;
}

/**
 * Build the HTML search URL:
 * `{base}/?q=…&c=1_0&f=0&s=seeders&o=desc[&p=N]`.
 *
 * Why HTML search instead of `/?page=rss`:
 * Nyaa's backend (`search.py`) hardcodes RSS requests to `ORDER BY id DESC LIMIT 75`,
 * ignoring `s=seeders`, `o=desc`, and `p=N`. Older high-seeder batches (such as
 * `[Judas] Bocchi the Rock! (Season 1)`) get pushed out of the latest 75 uploads
 * and never appear in the RSS feed. The HTML search endpoint sorts across Nyaa's
 * entire database on the server and defaults to `1_0` (All Anime: English-translated
 * `1_2`, Non-English-translated `1_3`, and Raw `1_4`).
 */
export function buildNyaaSearchUrl(q: NyaaSearchQuery, base: string = NYAA_DEFAULT_BASE_URL): string {
  const root = base.replace(/\/+$/, '');
  const params = [
    `q=${encodeURIComponent(q.query.trim())}`,
    `c=${encodeURIComponent(q.category ?? '1_0')}`,
    `f=${FILTER_PARAM[q.filter ?? 'none']}`,
    `s=${SORT_PARAM[q.sort ?? 'seeders']}`,
    'o=desc',
  ];
  if (q.page !== undefined && q.page > 1) params.push(`p=${Math.floor(q.page)}`);
  return `${root}/?${params.join('&')}`;
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/**
 * Parse a human size such as `1.4 GiB`, `742.5 MiB`, `512 KiB`, `12 Bytes`
 * (binary units; SI `MB`/`GB` use powers of 1000, bare `M`/`G` as in nginx
 * autoindex use 1024). Returns whole bytes, or `undefined` when unparsable.
 */
export function parseNyaaSize(text: string): number | undefined {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  if (!m) return undefined;
  const value = Number.parseFloat((m[1] as string).replace(',', '.'));
  const unit = (m[2] as string).toLowerCase() || 'b';
  const factor = SIZE_UNITS[unit];
  if (factor === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * factor);
}

/** Magnet link for a Nyaa torrent using Nyaa's default trackers. */
export function buildNyaaMagnet(infoHash: string, title: string): string {
  return buildMagnet({ infoHash, name: title, trackers: NYAA_TRACKERS });
}

/** Escape a tag name (`nyaa:infoHash`) for use in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/**
 * Item scanner with CDATA protection: CDATA bodies are swapped for
 * placeholders before tag matching (so markup inside them cannot confuse the
 * scanner) and restored verbatim when a field is read.
 */
class ItemScanner {
  private readonly cdata: string[] = [];
  private readonly body: string;

  constructor(itemXml: string) {
    this.body = itemXml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => {
      this.cdata.push(inner);
      return `\u0000${this.cdata.length - 1}\u0000`;
    });
  }

  /** Text content of the first `<name>` element (decoded, trimmed), or `undefined`. */
  text(name: string): string | undefined {
    const re = new RegExp(`<${escapeRe(name)}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${escapeRe(name)}\\s*>)`, 'i');
    const m = re.exec(this.body);
    if (!m) return undefined;
    const inner = m[1] ?? '';
    // Decode entities outside CDATA; splice CDATA contents back in untouched.
    return inner
      .split(/\u0000(\d+)\u0000/)
      .map((part, i) => (i % 2 === 1 ? (this.cdata[Number(part)] ?? '') : decodeXmlEntities(part)))
      .join('')
      .trim();
  }
}

function toCount(text: string | undefined): number {
  const n = Number.parseInt((text ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function isYes(text: string | undefined): boolean {
  return /^(?:yes|true|1)$/i.test(text ?? '');
}

function parseRssItemsOnly(xml: string): NyaaTorrentItem[] {
  const items: NyaaTorrentItem[] = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
  for (let m = itemRe.exec(xml); m; m = itemRe.exec(xml)) {
    const s = new ItemScanner(m[1] as string);
    const title = s.text('title');
    if (!title) continue;
    const link = s.text('link') ?? '';
    const pageUrl = s.text('guid') ?? '';
    let infoHash = normaliseInfoHash(s.text('nyaa:infoHash') ?? '');
    let torrentUrl = link;
    if (/^magnet:/i.test(link)) {
      try {
        infoHash ??= parseMagnet(link).infoHash;
      } catch {
        // keep whatever infoHash we have
      }
      const id = /\/view\/(\d+)/.exec(pageUrl);
      torrentUrl = id ? pageUrl.replace(/\/view\/\d+.*$/, `/download/${id[1]}.torrent`) : '';
    }
    const sizeText = s.text('nyaa:size') ?? '';
    const sizeBytes = parseNyaaSize(sizeText);
    const published = Date.parse(s.text('pubDate') ?? '');
    const item: NyaaTorrentItem = {
      title,
      torrentUrl,
      pageUrl,
      infoHash: infoHash ?? '',
      magnet: infoHash === undefined ? '' : buildNyaaMagnet(infoHash, title),
      seeders: toCount(s.text('nyaa:seeders')),
      leechers: toCount(s.text('nyaa:leechers')),
      downloads: toCount(s.text('nyaa:downloads')),
      sizeText,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      categoryId: s.text('nyaa:categoryId') ?? '',
      trusted: isYes(s.text('nyaa:trusted')),
      remake: isYes(s.text('nyaa:remake')),
      publishedAt: Number.isFinite(published) ? published : 0,
      parsedName: parseEpisodeName(title),
    };
    items.push(item);
  }
  return items;
}

function parseHtmlRowsOnly(html: string, base: string = NYAA_DEFAULT_BASE_URL): NyaaTorrentItem[] {
  const items: NyaaTorrentItem[] = [];
  const root = base.replace(/\/+$/, '');
  const tbodyMatch = /<tbody(?:\s[^>]*)?>([\s\S]*?)<\/tbody\s*>/i.exec(html);
  const scope = tbodyMatch ? (tbodyMatch[1] as string) : html;
  const trRe = /<tr(?:\s+([^>]*))?>([\s\S]*?)<\/tr\s*>/gi;

  for (let m = trRe.exec(scope); m; m = trRe.exec(scope)) {
    const trAttrs = m[1] ?? '';
    const trInner = m[2] ?? '';
    const rowClass = /\bclass\s*=\s*["']([^"']*)["']/i.exec(trAttrs)?.[1] ?? '';
    const trusted = /\bsuccess\b/i.test(rowClass);
    const remake = /\bdanger\b/i.test(rowClass);

    const cells: { attrs: string; inner: string }[] = [];
    const tdRe = /<td(?:\s+([^>]*))?>([\s\S]*?)<\/td\s*>/gi;
    for (let tm = tdRe.exec(trInner); tm; tm = tdRe.exec(trInner)) {
      cells.push({ attrs: tm[1] ?? '', inner: tm[2] ?? '' });
    }
    if (cells.length < 8) continue;

    // Cell 0: category link (`/?c=1_2`)
    const catMatch = /href\s*=\s*["'][^"']*\?c=([^"'&#\s]+)/i.exec(cells[0]!.inner);
    const categoryId = catMatch ? decodeXmlEntities(catMatch[1] as string).trim() : '';

    // Cell 1: title link (`/view/1861251`, ignoring `/view/1861251#comments`)
    let title = '';
    let pageUrl = '';
    const aRe = /<a(?:\s+([^>]*))?>([\s\S]*?)<\/a\s*>/gi;
    for (let am = aRe.exec(cells[1]!.inner); am; am = aRe.exec(cells[1]!.inner)) {
      const aAttrs = am[1] ?? '';
      const aInner = am[2] ?? '';
      const aClass = /\bclass\s*=\s*["']([^"']*)["']/i.exec(aAttrs)?.[1] ?? '';
      if (/\bcomments\b/i.test(aClass)) continue;
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(aAttrs)?.[1] ?? '';
      if (!/\/view\/\d+(?:$|\?)/i.test(href) || href.includes('#')) continue;
      const decodedHref = decodeXmlEntities(href).trim();
      pageUrl = /^https?:\/\//i.test(decodedHref) ? decodedHref : `${root}${decodedHref.startsWith('/') ? '' : '/'}${decodedHref}`;
      const titleAttr = /\btitle\s*=\s*["']([^"']*)["']/i.exec(aAttrs)?.[1];
      const rawTitle = titleAttr && titleAttr.trim() !== '' ? titleAttr : stripHtmlTags(aInner);
      title = decodeXmlEntities(rawTitle).replace(/\s+/g, ' ').trim();
    }
    if (!title) continue;

    // Cell 2: download (.torrent) and magnet links
    const dlMatch = /href\s*=\s*["']([^"']*\/download\/[^"']+\.torrent)["']/i.exec(cells[2]!.inner);
    const rawTorrent = dlMatch ? decodeXmlEntities(dlMatch[1] as string).trim() : '';
    const torrentUrl = rawTorrent
      ? /^https?:\/\//i.test(rawTorrent)
        ? rawTorrent
        : `${root}${rawTorrent.startsWith('/') ? '' : '/'}${rawTorrent}`
      : '';

    const magMatch = /href\s*=\s*["'](magnet:\?[^"']+)["']/i.exec(cells[2]!.inner);
    const rawMagnet = magMatch ? decodeXmlEntities(magMatch[1] as string).trim() : '';
    let infoHash: string | undefined;
    if (rawMagnet) {
      try {
        infoHash = parseMagnet(rawMagnet).infoHash;
      } catch {
        const hm = /xt=urn:btih:([0-9a-fA-F]{40})/i.exec(rawMagnet);
        if (hm) infoHash = normaliseInfoHash(hm[1] as string);
      }
    }
    const magnet = infoHash !== undefined ? buildNyaaMagnet(infoHash, title) : rawMagnet;

    // Cell 3: human size (`2.6 GiB`)
    const sizeText = decodeXmlEntities(stripHtmlTags(cells[3]!.inner)).trim();
    const sizeBytes = parseNyaaSize(sizeText);

    // Cell 4: timestamp (`data-timestamp="1723923229"`)
    const tsMatch = /\bdata-timestamp\s*=\s*["'](\d+)["']/i.exec(cells[4]!.attrs);
    let publishedAt = 0;
    if (tsMatch) {
      const secs = Number.parseInt(tsMatch[1] as string, 10);
      if (Number.isFinite(secs) && secs > 0) publishedAt = secs * 1000;
    } else {
      const parsedDate = Date.parse(decodeXmlEntities(stripHtmlTags(cells[4]!.inner)).trim());
      if (Number.isFinite(parsedDate)) publishedAt = parsedDate;
    }

    // Cells 5, 6, 7: seeders, leechers, completed downloads
    const seeders = toCount(stripHtmlTags(cells[5]!.inner));
    const leechers = toCount(stripHtmlTags(cells[6]!.inner));
    const downloads = toCount(stripHtmlTags(cells[7]!.inner));

    items.push({
      title,
      torrentUrl,
      pageUrl,
      infoHash: infoHash ?? '',
      magnet,
      seeders,
      leechers,
      downloads,
      sizeText,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      categoryId,
      trusted,
      remake,
      publishedAt,
      parsedName: parseEpisodeName(title),
    });
  }
  return items;
}

/**
 * Parse a Nyaa HTML search document (`<table class="torrent-list">`) into
 * torrent items. Automatically falls back to `parseNyaaRss` if the payload
 * is an RSS XML document.
 */
export function parseNyaaSearchHtml(html: string, base: string = NYAA_DEFAULT_BASE_URL): NyaaTorrentItem[] {
  if (typeof html !== 'string' || html === '') return [];
  const rows = parseHtmlRowsOnly(html, base);
  if (rows.length > 0) return rows;
  if (/<item[\s>]/i.test(html)) return parseRssItemsOnly(html);
  return [];
}

/**
 * Parse a Nyaa RSS document into torrent items.
 *
 * Tolerant: unknown/missing fields default (`0`, `false`, `''`), items
 * without a title are skipped, and garbage input yields `[]`. Automatically
 * falls back to `parseNyaaSearchHtml` if the payload is an HTML search table.
 */
export function parseNyaaRss(xml: string, base: string = NYAA_DEFAULT_BASE_URL): NyaaTorrentItem[] {
  if (typeof xml !== 'string' || xml === '') return [];
  const items = parseRssItemsOnly(xml);
  if (items.length > 0) return items;
  if (/<tr[\s>]/i.test(xml)) return parseHtmlRowsOnly(xml, base);
  return [];
}

/**
 * Deterministically sort Nyaa torrent items according to `sort` (`seeders`
 * by default).
 */
export function sortNyaaItems(
  items: readonly NyaaTorrentItem[],
  sort: NyaaSearchQuery['sort'] = 'seeders',
): NyaaTorrentItem[] {
  const mode = sort ?? 'seeders';
  return [...items].sort((a, b) => {
    if (mode === 'date') {
      return b.publishedAt - a.publishedAt || b.seeders - a.seeders || b.downloads - a.downloads;
    }
    if (mode === 'size') {
      return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || b.seeders - a.seeders || b.publishedAt - a.publishedAt;
    }
    if (mode === 'downloads') {
      return b.downloads - a.downloads || b.seeders - a.seeders || b.publishedAt - a.publishedAt;
    }
    return b.seeders - a.seeders || b.downloads - a.downloads || b.publishedAt - a.publishedAt;
  });
}

/**
 * Merge and deduplicate multiple Nyaa item lists (e.g. from multi-alias
 * Romanized + Native title queries for the same anime series) by `infoHash`
 * (or URL/title fallback) and sort deterministically.
 */
export function mergeNyaaItems(
  lists: readonly (readonly NyaaTorrentItem[])[],
  sort: NyaaSearchQuery['sort'] = 'seeders',
): NyaaTorrentItem[] {
  const byKey = new Map<string, NyaaTorrentItem>();
  for (const list of lists) {
    for (const item of list) {
      const key = (item.infoHash || item.torrentUrl || item.pageUrl || item.title).toLowerCase();
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing || item.seeders > existing.seeders) {
        byKey.set(key, item);
      }
    }
  }
  return sortNyaaItems([...byKey.values()], sort);
}
