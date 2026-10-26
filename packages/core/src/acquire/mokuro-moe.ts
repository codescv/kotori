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
