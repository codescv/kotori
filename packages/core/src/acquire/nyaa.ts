/**
 * nyaa.si RSS search: URL builder, tolerant RSS parser, size parser and
 * magnet synthesis with Nyaa's default tracker list.
 *
 * The parser is a hand-rolled `<item>` scanner (no DOMParser) so it runs
 * unchanged in Node, browsers and the Android WebView.
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

/**
 * Parse a Nyaa RSS document into torrent items.
 *
 * Tolerant: unknown/missing fields default (`0`, `false`, `''`), items
 * without a title are skipped, and garbage input yields `[]`. When `<link>`
 * is a magnet (the `&magnets` RSS variant) the info hash is taken from it and
 * `torrentUrl` is derived from the `guid` view URL.
 */
export function parseNyaaRss(xml: string): NyaaTorrentItem[] {
  const items: NyaaTorrentItem[] = [];
  if (typeof xml !== 'string') return items;
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
