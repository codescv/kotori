import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnimeEpisode, AppSettings, DownloadRequest, DownloadStatus, DownloadTask, HostEvent, Id, JimakuEntry, JimakuFile } from '@kotori/core';
import { openDatabase } from '../db/sqlite';
import { DownloadRepository } from '../db/repositories';
import { defaultSettings } from '../settings/store';
import { TorrentClient } from '../torrent';
import { createTorrentFile } from '../torrent/metainfo';
import { DownloadManager, PROGRESS_INTERVAL_MS } from './manager';
import type { DownloadImportHooks } from './manager';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function payload(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Route {
  readonly body: Uint8Array | string;
  /** Bytes per chunk (default: whole body). */
  readonly chunk?: number;
  /** Delay before each chunk. */
  readonly delayMs?: number;
  readonly status?: number;
  /** Honour `Range: bytes=N-` with 206 (default true). */
  readonly ranges?: boolean;
}

interface FetchLog {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** Fake `fetch` streaming route bodies in chunks; honours Range and AbortSignal. */
function fakeFetch(routes: Record<string, Route>, log: FetchLog[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    log.push({ url, headers });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    const full = typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body;
    let start = 0;
    let status = route.status ?? 200;
    const range = /^bytes=(\d+)-$/.exec(headers['range'] ?? '');
    if (range && route.ranges !== false && status === 200) {
      start = Number(range[1]);
      if (start >= full.length) return new Response(null, { status: 416 });
      status = 206;
    }
    const body = full.subarray(start);
    const chunk = route.chunk ?? Math.max(1, body.length);
    const signal = init?.signal ?? undefined;
    let pos = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (route.delayMs) await sleep(route.delayMs);
        if (signal?.aborted) {
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        if (pos >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(body.slice(pos, pos + chunk));
        pos += chunk;
      },
    });
    return new Response(status >= 400 ? null : stream, { status, headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
}

interface Harness {
  readonly manager: DownloadManager;
  readonly repo: DownloadRepository;
  readonly events: HostEvent[];
  readonly settings: { current: AppSettings };
  readonly dataDir: string;
  readonly hooks: DownloadImportHooks & { calls: Array<[string, ...unknown[]]> };
  readonly fetchLog: FetchLog[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `kotori-dl-${prefix}-`));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

function makeHooks(episodes: readonly AnimeEpisode[] = []): Harness['hooks'] {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    async importAnime(path) {
      calls.push(['importAnime', path]);
      return { seriesId: 'series-1' };
    },
    async importManga(path) {
      calls.push(['importManga', path]);
      return { volumeId: 'vol-1' };
    },
    async attachSubtitle(episodeId, filePath, fileName) {
      calls.push(['attachSubtitle', episodeId, filePath, fileName]);
      return { trackId: `track-${episodeId}` };
    },
    async listEpisodes(seriesId) {
      calls.push(['listEpisodes', seriesId]);
      return episodes;
    },
  };
}

async function harness(
  opts: {
    routes?: Record<string, Route>;
    episodes?: readonly AnimeEpisode[];
    settings?: (s: AppSettings) => AppSettings;
    repo?: DownloadRepository;
    dataDir?: string;
    torrentEngine?: () => TorrentClient;
  } = {},
): Promise<Harness> {
  const dataDir = opts.dataDir ?? (await tmp('data'));
  const base = defaultSettings(dataDir);
  const settings = { current: opts.settings ? opts.settings(base) : base };
  const repo = opts.repo ?? new DownloadRepository(openDatabase(':memory:'));
  const events: HostEvent[] = [];
  const hooks = makeHooks(opts.episodes);
  const fetchLog: FetchLog[] = [];
  const manager = new DownloadManager({
    repo,
    settings: () => settings.current,
    emit: (e) => events.push(e),
    dataDir,
    hooks,
    fetch: fakeFetch(opts.routes ?? {}, fetchLog),
    ...(opts.torrentEngine ? { torrentEngine: opts.torrentEngine } : {}),
  });
  cleanups.push(() => manager.dispose());
  return { manager, repo, events, settings, dataDir, hooks, fetchLog };
}

async function waitStatus(m: DownloadManager, id: Id, status: DownloadStatus, timeoutMs = 10_000): Promise<DownloadTask> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = m.get(id);
    if (t.status === status) return t;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${status}; task is ${t.status} ${t.error ?? ''}`);
    await sleep(10);
  }
}

const updatesFor = (events: readonly HostEvent[], id: Id): DownloadTask[] =>
  events.flatMap((e) => (e.type === 'download-updated' && e.task.id === id ? [e.task] : []));

function episode(id: string, n: number): AnimeEpisode {
  return {
    id,
    seriesId: 'series-1',
    title: `Episode ${n}`,
    fileName: `Show - ${String(n).padStart(2, '0')}.mkv`,
    filePath: `/lib/Show - ${String(n).padStart(2, '0')}.mkv`,
    container: 'mkv',
    sizeBytes: 1,
    parsedName: { raw: `Show - ${n}`, title: 'Show', episode: n, isBatch: false },
    subtitleTracks: [],
    mediaUrl: `/media/${id}`,
  };
}

const jimakuEntry: JimakuEntry = { id: 7, name: 'Show', flags: { anime: true, unverified: false, external: false, movie: false, adult: false } };
function jimakuFile(name: string, url: string): JimakuFile {
  const extension = name.split('.').pop() ?? '';
  return { entryId: 7, name, url, extension, isTextSubtitle: extension !== 'zip' };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('DownloadManager — http', () => {
  it('streams to disk with coalesced progress events and immediate status changes', async () => {
    const body = payload(120_000, 1);
    const h = await harness({ routes: { 'https://x.test/file.bin': { body, chunk: 10_000, delayMs: 100 } } });
    const task = await h.manager.start({ source: { kind: 'http', url: 'https://x.test/file.bin' }, autoImport: false });
    expect(task.kind).toBe('http-file');
    expect(task.title).toBe('file.bin');
    const done = await waitStatus(h.manager, task.id, 'completed');
    expect(done.progress).toBe(1);
    expect(done.downloadedBytes).toBe(body.length);
    expect(done.totalBytes).toBe(body.length);
    const onDisk = new Uint8Array(await readFile(join(h.settings.current.downloads.downloadDir, 'file.bin')));
    expect(Buffer.from(onDisk).equals(Buffer.from(body))).toBe(true);

    const updates = updatesFor(h.events, task.id);
    const statuses = updates.map((u) => u.status).filter((s, i, a) => s !== a[i - 1]);
    expect(statuses).toEqual(['queued', 'downloading', 'completed']);
    // Progress-only updates (same status as the previous update) are ≥ ~500 ms apart.
    const progressOnly = updates.filter((u, i) => i > 0 && u.status === updates[i - 1]?.status);
    expect(progressOnly.length).toBeGreaterThan(0);
    expect(progressOnly.length).toBeLessThanOrEqual(Math.ceil(1300 / PROGRESS_INTERVAL_MS));
    for (let i = 1; i < progressOnly.length; i++) {
      expect(progressOnly[i]!.updatedAt - progressOnly[i - 1]!.updatedAt).toBeGreaterThanOrEqual(PROGRESS_INTERVAL_MS - 20);
    }
    // Persisted.
    expect(h.repo.get(task.id)?.status).toBe('completed');
  });

  it('pauses mid-download and resumes with an HTTP Range request', async () => {
    const body = payload(200_000, 2);
    const url = 'https://x.test/big.mkv';
    const h = await harness({ routes: { [url]: { body, chunk: 8_000, delayMs: 15 } } });
    const task = await h.manager.start({ source: { kind: 'http', url }, autoImport: false });
    await waitStatus(h.manager, task.id, 'downloading');
    await sleep(120);
    const paused = await h.manager.pause(task.id);
    expect(paused.status).toBe('paused');
    await sleep(60);
    const dest = join(h.settings.current.downloads.downloadDir, 'big.mkv');
    const partial = (await stat(dest)).size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(body.length);

    await h.manager.resume(task.id);
    const done = await waitStatus(h.manager, task.id, 'completed');
    expect(done.downloadedBytes).toBe(body.length);
    expect(Buffer.from(await readFile(dest)).equals(Buffer.from(body))).toBe(true);
    const rangeReq = h.fetchLog.filter((l) => l.url === url)[1];
    expect(rangeReq?.headers['range']).toMatch(/^bytes=\d+-$/);
  });

  it('restarts from scratch when the server ignores Range', async () => {
    const body = payload(30_000, 3);
    const url = 'https://x.test/norange.bin';
    const h = await harness({ routes: { [url]: { body, ranges: false } } });
    const dest = join(h.settings.current.downloads.downloadDir, 'norange.bin');
    await mkdir(h.settings.current.downloads.downloadDir, { recursive: true });
    await writeFile(dest, new Uint8Array(5000).fill(9)); // stale partial
    const task = await h.manager.start({ source: { kind: 'http', url }, autoImport: false });
    await waitStatus(h.manager, task.id, 'completed');
    expect(Buffer.from(await readFile(dest)).equals(Buffer.from(body))).toBe(true);
  });

  it('cancels, then removes with deleteFiles', async () => {
    const url = 'https://x.test/slow.bin';
    const h = await harness({ routes: { [url]: { body: payload(100_000, 4), chunk: 1000, delayMs: 20 } } });
    const task = await h.manager.start({ source: { kind: 'http', url }, autoImport: false });
    await waitStatus(h.manager, task.id, 'downloading');
    await sleep(80);
    expect((await h.manager.cancel(task.id)).status).toBe('cancelled');
    await sleep(50);
    expect(h.manager.get(task.id).status).toBe('cancelled');
    const dest = join(h.settings.current.downloads.downloadDir, 'slow.bin');
    expect((await stat(dest)).size).toBeGreaterThan(0);

    await h.manager.remove(task.id, true);
    await expect(stat(dest)).rejects.toThrow();
    expect(() => h.manager.get(task.id)).toThrow();
    expect(h.repo.get(task.id)).toBeUndefined();
    expect(h.events.some((e) => e.type === 'download-removed' && e.taskId === task.id)).toBe(true);
  });

  it('marks HTTP errors as failed and resume() retries', async () => {
    const h = await harness({ routes: { 'https://x.test/err': { body: 'nope', status: 503 } } });
    const task = await h.manager.start({ source: { kind: 'http', url: 'https://x.test/err', fileName: 'err.bin' }, autoImport: false });
    const failed = await waitStatus(h.manager, task.id, 'failed');
    expect(failed.error).toMatch(/503/);
    await h.manager.resume(task.id);
    await waitStatus(h.manager, task.id, 'failed');
    expect(h.fetchLog.filter((l) => l.url === 'https://x.test/err')).toHaveLength(2);
  });

  it('queues beyond maxActiveDownloads', async () => {
    const routes: Record<string, Route> = {
      'https://x.test/a': { body: payload(20_000, 5), chunk: 2000, delayMs: 20 },
      'https://x.test/b': { body: payload(20_000, 6), chunk: 2000, delayMs: 20 },
    };
    const h = await harness({
      routes,
      settings: (s) => ({ ...s, downloads: { ...s.downloads, maxActiveDownloads: 1 } }),
    });
    const a = await h.manager.start({ source: { kind: 'http', url: 'https://x.test/a', fileName: 'a' }, autoImport: false });
    const b = await h.manager.start({ source: { kind: 'http', url: 'https://x.test/b', fileName: 'b' }, autoImport: false });
    await waitStatus(h.manager, a.id, 'downloading');
    expect(h.manager.get(b.id).status).toBe('queued');
    await waitStatus(h.manager, a.id, 'completed');
    await waitStatus(h.manager, b.id, 'completed');
    const bUpdates = updatesFor(h.events, b.id);
    const firstBDownloading = bUpdates.find((u) => u.status === 'downloading')!.updatedAt;
    expect(firstBDownloading).toBeGreaterThanOrEqual(h.manager.get(a.id).completedAt!);
  });

  it('validates requests', async () => {
    const h = await harness();
    await expect(h.manager.start({ source: { kind: 'http', url: 'ftp://x/y' }, autoImport: false })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      h.manager.start({ source: { kind: 'torrent', infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a' }, autoImport: false }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(h.manager.start({ source: { kind: 'torrent', infoHash: 'nope' }, autoImport: false } as DownloadRequest)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(() => h.manager.get('missing')).toThrow();
  });
});

describe('DownloadManager — jimaku', () => {
  it('downloads a single subtitle and attaches it to the requested episode', async () => {
    const url = 'https://jimaku.test/files/Show - 02.ass';
    const h = await harness({
      routes: { [url]: { body: '[Script Info]\nTitle: x\n' } },
      episodes: [episode('ep1', 1), episode('ep2', 2)],
      settings: (s) => ({ ...s, anime: { ...s.anime, jimakuApiKey: 'secret-key' } }),
    });
    const task = await h.manager.start({
      source: { kind: 'jimaku', entry: jimakuEntry, file: jimakuFile('Show - 02.ass', url), episodeId: 'ep2', seriesId: 'series-1' },
      autoImport: true,
    });
    expect(task.kind).toBe('jimaku-subtitle');
    const done = await waitStatus(h.manager, task.id, 'completed');
    expect(done.importedTrackId).toBe('track-ep2');
    expect(h.fetchLog[0]?.headers['authorization']).toBe('secret-key');
    const attach = h.hooks.calls.filter((c) => c[0] === 'attachSubtitle');
    expect(attach).toHaveLength(1);
    expect(attach[0]?.[1]).toBe('ep2');
    expect(String(attach[0]?.[2])).toBe(join(h.dataDir, 'subtitles', 'jimaku', 'Show', 'Show - 02.ass'));
    expect(h.events.some((e) => e.type === 'library-changed' && e.scope === 'anime')).toBe(true);
  });

  it('unpacks a .zip season pack and matches files to episodes', async () => {
    const te = new TextEncoder();
    const zip = zipSync({
      '[Sub] Show - 01.ass': te.encode('one'),
      'nested/[Sub] Show - 02.srt': te.encode('1\n00:00:01,000 --> 00:00:02,000\nhi\n'),
      '__MACOSX/._[Sub] Show - 01.ass': te.encode('junk'),
      'readme.txt': te.encode('ignore me'),
    });
    const url = 'https://jimaku.test/files/pack.zip';
    const h = await harness({ routes: { [url]: { body: zip } }, episodes: [episode('ep1', 1), episode('ep2', 2), episode('ep3', 3)] });
    const task = await h.manager.start({
      source: { kind: 'jimaku', entry: jimakuEntry, file: jimakuFile('pack.zip', url), seriesId: 'series-1' },
      autoImport: true,
    });
    const done = await waitStatus(h.manager, task.id, 'completed');
    expect(done.files?.map((f) => f.path).sort()).toEqual(['[Sub] Show - 01.ass', '[Sub] Show - 02.srt']);
    const attach = h.hooks.calls.filter((c) => c[0] === 'attachSubtitle').map((c) => [c[1], c[3]]);
    expect(attach).toEqual([
      ['ep1', '[Sub] Show - 01.ass'],
      ['ep2', '[Sub] Show - 02.srt'],
    ]);
    const extracted = await readFile(join(h.dataDir, 'subtitles', 'jimaku', 'Show', 'pack', '[Sub] Show - 01.ass'), 'utf8');
    expect(extracted).toBe('one');
  });

  it('fails packs without subtitles', async () => {
    const url = 'https://jimaku.test/files/empty.zip';
    const h = await harness({ routes: { [url]: { body: zipSync({ 'a.txt': new Uint8Array(1) }) } } });
    const task = await h.manager.start({ source: { kind: 'jimaku', entry: jimakuEntry, file: jimakuFile('empty.zip', url) }, autoImport: true });
    const failed = await waitStatus(h.manager, task.id, 'failed');
    expect(failed.error).toMatch(/no \.ass/);
  });
});

describe('DownloadManager — mokuro-moe', () => {
  it('downloads .mokuro + image archive and imports the volume', async () => {
    const mokuro = JSON.stringify({ version: '0.2.0', title: 'T', volume: 'Vol 1', pages: [] });
    const cbz = zipSync({ '001.jpg': new Uint8Array([0xff, 0xd8, 0xff]) });
    const h = await harness({
      routes: { 'https://m.test/T/Vol 1.mokuro': { body: mokuro }, 'https://m.test/T/Vol 1.cbz': { body: cbz } },
    });
    const task = await h.manager.start({
      source: {
        kind: 'mokuro-moe',
        volume: { name: 'Vol 1', mokuroUrl: 'https://m.test/T/Vol 1.mokuro', imagesUrl: 'https://m.test/T/Vol 1.cbz', imagesKind: 'archive' },
      },
      autoImport: true,
    });
    const done = await waitStatus(h.manager, task.id, 'completed');
    const dir = join(h.dataDir, 'manga', 'Vol 1');
    expect(done.targetDir).toBe(dir);
    expect(done.importedVolumeId).toBe('vol-1');
    expect(done.downloadedBytes).toBe(Buffer.byteLength(mokuro) + cbz.length);
    expect(await readFile(join(dir, 'Vol 1.mokuro'), 'utf8')).toBe(mokuro);
    expect((await stat(join(dir, 'Vol 1.cbz'))).size).toBe(cbz.length);
    expect(h.hooks.calls).toContainEqual(['importManga', join(dir, 'Vol 1.mokuro')]);
    expect(h.events.some((e) => e.type === 'library-changed' && e.scope === 'manga')).toBe(true);
  });

  it('downloads an image directory listing', async () => {
    const listing = `<html><body><h1>Index of /T/Vol 2/</h1><pre><a href="../">../</a>
<a href="001.jpg">001.jpg</a>   01-Jan-2024 10:00   3
<a href="002.png">002.png</a>   01-Jan-2024 10:00   4
<a href="notes.txt">notes.txt</a>   01-Jan-2024 10:00   1
</pre></body></html>`;
    const h = await harness({
      routes: {
        'https://m.test/T/Vol 2.mokuro': { body: '{"pages":[]}' },
        'https://m.test/T/Vol%202/': { body: listing },
        'https://m.test/T/Vol%202/001.jpg': { body: new Uint8Array([1, 2, 3]) },
        'https://m.test/T/Vol%202/002.png': { body: new Uint8Array([4, 5, 6, 7]) },
      },
    });
    const task = await h.manager.start({
      source: {
        kind: 'mokuro-moe',
        volume: { name: 'Vol 2', mokuroUrl: 'https://m.test/T/Vol 2.mokuro', imagesUrl: 'https://m.test/T/Vol%202/', imagesKind: 'dir' },
      },
      autoImport: true,
    });
    await waitStatus(h.manager, task.id, 'completed');
    const dir = join(h.dataDir, 'manga', 'Vol 2', 'Vol 2');
    expect(new Uint8Array(await readFile(join(dir, '001.jpg')))).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await readFile(join(dir, '002.png')))).toEqual(new Uint8Array([4, 5, 6, 7]));
    await expect(stat(join(dir, 'notes.txt'))).rejects.toThrow();
    expect(h.hooks.calls.filter((c) => c[0] === 'importManga')).toHaveLength(1);
  });
});

describe('DownloadManager — persistence', () => {
  it('init() re-queues interrupted tasks and keeps finished ones', async () => {
    const dataDir = await tmp('data');
    const repo = new DownloadRepository(openDatabase(':memory:'));
    const downloadDir = join(dataDir, 'downloads');
    const base = { progress: 0.3, downloadedBytes: 10, speedBps: 999, targetDir: downloadDir, createdAt: 1, updatedAt: 1 } as const;
    repo.put({ ...base, id: 'dl_a', kind: 'http-file', source: { kind: 'http', url: 'https://x.test/resume.bin' }, title: 'resume.bin', status: 'downloading' });
    repo.put({ ...base, id: 'dl_b', kind: 'http-file', source: { kind: 'http', url: 'https://x.test/done.bin' }, title: 'done.bin', status: 'completed', progress: 1 });
    const body = payload(5000, 7);
    const h = await harness({ repo, dataDir, routes: { 'https://x.test/resume.bin': { body } } });
    h.manager.init();
    expect(h.manager.list().map((t) => t.id).sort()).toEqual(['dl_a', 'dl_b']);
    await waitStatus(h.manager, 'dl_a', 'completed');
    expect(h.manager.get('dl_b').status).toBe('completed');
    expect(h.fetchLog.map((l) => l.url)).toEqual(['https://x.test/resume.bin']);
    expect(Buffer.from(await readFile(join(downloadDir, 'resume.bin'))).equals(Buffer.from(body))).toBe(true);
  });
});

describe('DownloadManager — torrent (real TorrentClient over loopback)', () => {
  it('downloads via the engine, then auto-imports the anime folder', async () => {
    const NAME = '[Kotori] Show';
    const files = [
      { path: '[Kotori] Show - 01 (1080p).mkv', data: payload(600_000, 21) },
      { path: '[Kotori] Show - 01 (1080p).ja.ass', data: payload(3_000, 22) },
    ];
    // Seeder.
    const seedDir = await tmp('seed');
    for (const f of files) {
      await mkdir(join(seedDir, NAME), { recursive: true });
      await writeFile(join(seedDir, NAME, f.path), f.data);
    }
    const torrentBytes = createTorrentFile({ name: NAME, files, pieceLength: 32 * 1024 });
    const seeder = new TorrentClient({ dataDir: await tmp('seed-data'), dht: false, trackers: false });
    cleanups.push(() => seeder.destroy());
    const seed = await seeder.add({ torrentFile: torrentBytes }, { downloadDir: seedDir, seedAfterComplete: true });
    await new Promise<void>((r) => (seed.status === 'seeding' ? r() : seed.on('status', (s) => s === 'seeding' && r())));

    // Manager with a real engine; the magnet carries the seeder as an x.pe peer.
    const engineData = await tmp('engine-data');
    const h = await harness({ torrentEngine: () => new TorrentClient({ dataDir: engineData, dht: false, trackers: false }) });
    const magnet = `magnet:?xt=urn:btih:${seed.infoHash}&dn=${encodeURIComponent(NAME)}&x.pe=127.0.0.1:${seeder.port}`;
    const task = await h.manager.start({ source: { kind: 'torrent', infoHash: seed.infoHash, magnet }, autoImport: true });
    expect(task.kind).toBe('torrent');
    expect(task.title).toBe(NAME);
    const done = await waitStatus(h.manager, task.id, 'completed', 20_000);
    const root = join(h.settings.current.downloads.downloadDir, NAME);
    expect(done.importedSeriesId).toBe('series-1');
    expect(done.files?.map((f) => f.path)).toEqual(files.map((f) => `${NAME}/${f.path}`));
    expect(h.hooks.calls).toContainEqual(['importAnime', root]);
    for (const f of files) expect(Buffer.from(await readFile(join(root, f.path))).equals(Buffer.from(f.data))).toBe(true);
    const statuses = updatesFor(h.events, task.id)
      .map((u) => u.status)
      .filter((s, i, a) => s !== a[i - 1]);
    expect(statuses[0]).toBe('queued');
    expect(statuses).toContain('importing');
    expect(statuses.at(-1)).toBe('completed');
  }, 30_000);
});
