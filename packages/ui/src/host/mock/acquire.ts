/**
 * Mock acquisition fixtures: Nyaa search results, Jimaku entries/files, a
 * mokuro.moe catalog tree and a fake server-side file system for the path
 * browser.
 */
import type {
  DirectoryEntry,
  JimakuEntry,
  JimakuFile,
  MokuroCatalogEntry,
  MokuroCatalogListing,
  NyaaSearchQuery,
  NyaaTorrentItem,
} from '@kotori/core';
import { hashString } from './explanations';

const TRACKERS = ['http://nyaa.tracker.wf:7777/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.opentrackr.org:1337/announce'];
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12);

const hex40 = (seed: string): string => (hashString(seed) + hashString(`${seed}#2`) + hashString(`${seed}#3`) + hashString(`${seed}#4`) + hashString(`${seed}#5`)).slice(0, 40);

export function mockNyaaSearch(q: NyaaSearchQuery): NyaaTorrentItem[] {
  const base = q.query.trim() || 'Kotori no Yakusoku';
  const groups = ['SubsPlease', 'Kotori-Raws', 'Erai-raws', 'ASW', 'Ohys-Raws', 'LoliHouse'];
  const items: NyaaTorrentItem[] = [];
  for (let i = 0; i < 12; i++) {
    const group = groups[i % groups.length] ?? 'Raws';
    const ep = 12 - i;
    const batch = i === 11;
    const res = i % 3 === 0 ? '720p' : '1080p';
    const title = batch ? `[${group}] ${base} (01-12) [BD ${res} HEVC FLAC] [Batch]` : `[${group}] ${base} - ${String(ep).padStart(2, '0')} (${res}) [${hashString(`${base}${i}`).toUpperCase()}].mkv`;
    const infoHash = hex40(title);
    const sizeBytes = batch ? 14.2 * 1024 ** 3 : (res === '720p' ? 0.35 : 1.38) * 1024 ** 3;
    items.push({
      title,
      torrentUrl: `https://nyaa.si/download/${1900000 + i}.torrent`,
      pageUrl: `https://nyaa.si/view/${1900000 + i}`,
      infoHash,
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}${TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`,
      seeders: Math.max(0, 480 - i * 37),
      leechers: 30 - i * 2,
      downloads: 5200 - i * 300,
      sizeText: batch ? '14.2 GiB' : res === '720p' ? '358.4 MiB' : '1.4 GiB',
      sizeBytes: Math.round(sizeBytes),
      categoryId: q.category ?? '1_4',
      trusted: i % 4 !== 3,
      remake: i === 7,
      publishedAt: NOW - i * DAY * 7,
      parsedName: {
        raw: title,
        title: base,
        ...(batch ? { episodeRange: [1, 12] as const } : { episode: ep }),
        releaseGroup: group,
        resolution: res,
        isBatch: batch,
        ...(batch ? { source: 'BD' as const } : {}),
      },
    });
  }
  return items.filter((it) => (q.filter === 'trusted-only' ? it.trusted : q.filter === 'no-remakes' ? !it.remake : true));
}

const JIMAKU_ENTRIES: readonly JimakuEntry[] = [
  { id: 4242, name: 'Kotori no Yakusoku', japaneseName: 'ことりの約束', englishName: "Kotori's Promise", anilistId: 170000, flags: { anime: true, unverified: false, external: false, movie: false, adult: false }, lastModifiedAt: NOW - 2 * DAY },
  { id: 4243, name: 'Hoshikuzu Radio', japaneseName: '星屑ラジオ', englishName: 'Stardust Radio', anilistId: 170001, flags: { anime: true, unverified: false, external: false, movie: false, adult: false }, lastModifiedAt: NOW - 9 * DAY },
  { id: 5001, name: 'Houkago Note', japaneseName: '放課後ノート', anilistId: 170002, flags: { anime: true, unverified: true, external: false, movie: false, adult: false }, lastModifiedAt: NOW - 30 * DAY },
];

export function mockJimakuSearch(query: string | undefined, anilistId?: number): JimakuEntry[] {
  const q = (query ?? '').trim().toLowerCase();
  return JIMAKU_ENTRIES.filter(
    (e) =>
      (anilistId !== undefined && e.anilistId === anilistId) ||
      q === '' ||
      e.name.toLowerCase().includes(q) ||
      (e.japaneseName ?? '').includes(query ?? '') ||
      (e.englishName ?? '').toLowerCase().includes(q),
  );
}

export function mockJimakuFiles(entryId: number, episode?: number): JimakuFile[] {
  const entry = JIMAKU_ENTRIES.find((e) => e.id === entryId);
  if (!entry) return [];
  const files: JimakuFile[] = [];
  for (let ep = 1; ep <= 3; ep++) {
    for (const ext of ['ass', 'srt'] as const) {
      const name = `${entry.japaneseName ?? entry.name} 第${String(ep).padStart(2, '0')}話.${ext}`;
      files.push({ entryId, name, url: `https://jimaku.cc/entry/${entryId}/download/${encodeURIComponent(name)}`, sizeBytes: ext === 'ass' ? 48_200 : 21_400, lastModifiedAt: NOW - ep * DAY, extension: ext, isTextSubtitle: true, episode: ep });
    }
  }
  files.push({ entryId, name: `${entry.name} S01 Season Pack.zip`, url: `https://jimaku.cc/entry/${entryId}/download/pack.zip`, sizeBytes: 612_000, lastModifiedAt: NOW - 3 * DAY, extension: 'zip', isTextSubtitle: false, archiveFormat: 'zip' });
  return episode === undefined ? files : files.filter((f) => f.episode === episode || f.episode === undefined);
}

const CATALOG_ROOT = 'https://mokuro.moe/manga/';

const MOCK_MANGA_META: Record<
  string,
  {
    romaji: string;
    english: string;
    score: number;
    volumes: number;
    pages: number;
    chars: number;
    genres: readonly string[];
    tags: readonly string[];
  }
> = {
  放課後ノート: {
    romaji: 'Houkago Note',
    english: 'After-School Notebook',
    score: 84,
    volumes: 4,
    pages: 720,
    chars: 58_400,
    genres: ['Slice of Life', 'School', 'Comedy'],
    tags: ['Club', 'Youth'],
  },
  'よつばと！': {
    romaji: 'Yotsuba to!',
    english: 'Yotsuba&!',
    score: 89,
    volumes: 15,
    pages: 3120,
    chars: 215_000,
    genres: ['Comedy', 'Slice of Life'],
    tags: ['Iyashikei', 'Parenting', 'Beginner Friendly'],
  },
  'ハイキュー!!': {
    romaji: 'Haikyuu!!',
    english: 'Haikyu!!',
    score: 91,
    volumes: 45,
    pages: 8910,
    chars: 842_000,
    genres: ['Sports', 'Drama', 'Comedy'],
    tags: ['Volleyball', 'Shounen'],
  },
  葬送のフリーレン: {
    romaji: 'Sousou no Frieren',
    english: 'Frieren: Beyond Journey’s End',
    score: 93,
    volumes: 13,
    pages: 2560,
    chars: 312_000,
    genres: ['Adventure', 'Drama', 'Fantasy'],
    tags: ['Elves', 'Magic', 'Philosophical'],
  },
  'ゆるキャン△': {
    romaji: 'Yuru Camp△',
    english: 'Laid-Back Camp',
    score: 86,
    volumes: 16,
    pages: 2880,
    chars: 248_000,
    genres: ['Slice of Life', 'Comedy'],
    tags: ['Camping', 'Outdoors', 'Iyashikei'],
  },
};

export function mockMokuroCatalog(url?: string): MokuroCatalogListing {
  const u = url && url.startsWith(CATALOG_ROOT) ? url : CATALOG_ROOT;
  const rel = decodeURIComponent(u.slice(CATALOG_ROOT.length)).replace(/\/$/, '');
  const path = rel ? rel.split('/') : [];
  const dir = (name: string): MokuroCatalogEntry => {
    const meta = MOCK_MANGA_META[name];
    return {
      kind: 'dir',
      name,
      url: `${u}${encodeURIComponent(name)}/`,
      isMokuro: false,
      isImageArchive: false,
      modifiedAt: NOW - 40 * DAY,
      ...(meta
        ? {
            nativeTitle: name,
            romajiTitle: meta.romaji,
            englishTitle: meta.english,
            score: meta.score,
            volumeCount: meta.volumes,
            totalPages: meta.pages,
            totalChars: meta.chars,
            genres: meta.genres,
            tags: meta.tags,
            sizeText: `${meta.volumes} vols · ${meta.pages}p`,
          }
        : {}),
    };
  };
  if (path.length === 0) {
    const entries = ['放課後ノート', 'よつばと！', 'ハイキュー!!', '葬送のフリーレン', 'ゆるキャン△'].map(dir);
    return { url: u, path, entries, volumes: [] };
  }
  const series = path[0] ?? '';
  const entries: MokuroCatalogEntry[] = [];
  const volumes = [];
  for (let v = 1; v <= 4; v++) {
    const name = `${series} 第${String(v).padStart(2, '0')}巻`;
    const mokuroUrl = `${u}${encodeURIComponent(name)}.mokuro`;
    const imagesUrl = `${u}${encodeURIComponent(name)}.zip`;
    entries.push({ kind: 'file', name: `${name}.mokuro`, url: mokuroUrl, sizeText: '1.2M', sizeBytes: 1_250_000, modifiedAt: NOW - v * DAY, isMokuro: true, isImageArchive: false });
    entries.push({ kind: 'file', name: `${name}.zip`, url: imagesUrl, sizeText: '86M', sizeBytes: 86_000_000 + v * 1_000_000, modifiedAt: NOW - v * DAY, isMokuro: false, isImageArchive: true });
    volumes.push({ name, mokuroUrl, imagesUrl, imagesKind: 'archive' as const, sizeBytes: 87_250_000 + v * 1_000_000, pageCount: 176 + v * 4 });
  }
  return { url: u, path, entries, volumes };
}

/** Fake server-side directory tree for `files.listDirectory`. */
const FS: Record<string, readonly DirectoryEntry[]> = {
  '/': [{ name: 'home', path: '/home', kind: 'dir' }],
  '/home': [{ name: 'kotori', path: '/home/kotori', kind: 'dir' }],
  '/home/kotori': [
    { name: 'Anime', path: '/home/kotori/Anime', kind: 'dir' },
    { name: 'Manga', path: '/home/kotori/Manga', kind: 'dir' },
    { name: 'Downloads', path: '/home/kotori/Downloads', kind: 'dir' },
  ],
  '/home/kotori/Anime': [
    { name: 'Natsuzora Diary', path: '/home/kotori/Anime/Natsuzora Diary', kind: 'dir' },
    { name: 'Umibe no Kissaten', path: '/home/kotori/Anime/Umibe no Kissaten', kind: 'dir' },
  ],
  '/home/kotori/Anime/Natsuzora Diary': [
    { name: '[Kotori-Raws] Natsuzora Diary - 01 (1080p).mkv', path: '/home/kotori/Anime/Natsuzora Diary/01.mkv', kind: 'file', sizeBytes: 1_300_000_000 },
    { name: '[Kotori-Raws] Natsuzora Diary - 01 (1080p).ja.ass', path: '/home/kotori/Anime/Natsuzora Diary/01.ja.ass', kind: 'file', sizeBytes: 52_000 },
  ],
  '/home/kotori/Anime/Umibe no Kissaten': [],
  '/home/kotori/Manga': [
    { name: '夏空ダイアリー 第1巻.mokuro', path: '/home/kotori/Manga/夏空ダイアリー 第1巻.mokuro', kind: 'file', sizeBytes: 1_100_000 },
    { name: '夏空ダイアリー 第1巻', path: '/home/kotori/Manga/夏空ダイアリー 第1巻', kind: 'dir' },
    { name: '海辺の喫茶店 01.cbz', path: '/home/kotori/Manga/海辺の喫茶店 01.cbz', kind: 'file', sizeBytes: 74_000_000 },
  ],
  '/home/kotori/Manga/夏空ダイアリー 第1巻': [],
  '/home/kotori/Downloads': [],
};

export function mockListDirectory(path?: string): { path: string; parent?: string; entries: readonly DirectoryEntry[] } {
  const p = path && FS[path] ? path : '/home/kotori';
  const parent = p === '/' ? undefined : p.slice(0, p.lastIndexOf('/')) || '/';
  return parent === undefined ? { path: p, entries: FS[p] ?? [] } : { path: p, parent, entries: FS[p] ?? [] };
}
