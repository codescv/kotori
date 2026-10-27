import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import type { DownloadStatus, DownloadTask, HostEvent, JimakuEntry, JimakuFile, PlatformHost } from '@kotori/core';
import { createTestHost, pngHeader, type TestHost } from './testing/harness';
import { fixtureBytes, fixtureText, loadFixtureDir } from './testing/fixtures';

const open: TestHost[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.host.dispose()));
});

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Body stream that delivers `chunks` pieces and advances the fake clock per chunk. */
function chunkedBody(bytes: Uint8Array, chunks: number, clock: { now: number }, stepMs: number): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.length / chunks);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      clock.now += stepMs;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function host(route: Route, overrides: Parameters<typeof createTestHost>[0] = {}): Promise<TestHost & { urls: string[]; inits: (RequestInit | undefined)[] }> {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const t = await createTestHost({
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      inits.push(init);
      return route(url, init);
    },
    ...overrides,
  });
  open.push(t);
  return { ...t, urls, inits };
}

function waitFor(h: PlatformHost, taskId: string, status: DownloadStatus, timeoutMs = 3000): Promise<DownloadTask> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${status}`));
    }, timeoutMs);
    const off = h.subscribe((e) => {
      if (e.type === 'download-updated' && e.task.id === taskId && e.task.status === status) {
        clearTimeout(timer);
        off();
        resolve(e.task);
      }
    });
    void h.downloads.get(taskId).then((task) => {
      if (task.status === status) {
        clearTimeout(timer);
        off();
        resolve(task);
      }
    });
  });
}

const payload = new Uint8Array(200_000).map((_, i) => i % 251);

/** Fast byte equality (deep-equal on 200 KB typed arrays is slow in vitest). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

describe('downloads', () => {
  it('http download streams to downloads/, coalesces progress events (≤ 1 per 500 ms) and emits every status change', async () => {
    let clock = { now: 0 };
    const t = await host(() => new Response(chunkedBody(payload, 20, clock, 100), { headers: { 'content-length': String(payload.length) } }));
    clock = t.clock;
    const events: HostEvent[] = [];
    t.host.subscribe((e) => events.push(e));
    const task = await t.host.downloads.start({ source: { kind: 'http', url: 'https://example.com/files/raw%20episode.mkv' }, autoImport: false });
    expect(task.kind).toBe('http-file');
    const done = await waitFor(t.host, task.id, 'completed');
    expect(done).toMatchObject({ progress: 1, downloadedBytes: payload.length, totalBytes: payload.length, speedBps: 0 });
    const dest = `${t.deps.dataRoot}/downloads/raw episode.mkv`;
    expect(done.files?.[0]).toMatchObject({ path: dest, sizeBytes: payload.length, downloadedBytes: payload.length });
    expect(sameBytes(await t.fs.readFile(dest), payload)).toBe(true);

    const updates = events.flatMap((e) => (e.type === 'download-updated' && e.task.id === task.id ? [e.task] : []));
    const statuses = updates.map((u) => u.status).filter((s, i, a) => i === 0 || a[i - 1] !== s);
    expect(statuses).toEqual(['queued', 'downloading', 'completed']);
    const progressEvents = updates.filter((u) => u.status === 'downloading').slice(1);
    // 20 chunks × 100 ms = 2 s of fake time → at most one progress event per 500 ms.
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < progressEvents.length; i++) {
      expect((progressEvents[i]?.updatedAt ?? 0) - (progressEvents[i - 1]?.updatedAt ?? 0)).toBeGreaterThanOrEqual(500);
    }
    expect(progressEvents.every((p, i, a) => i === 0 || p.downloadedBytes >= (a[i - 1]?.downloadedBytes ?? 0))).toBe(true);
    expect((await t.host.downloads.list()).map((x) => x.id)).toEqual([task.id]);
  });

  it('jimaku download auto-attaches the subtitle to the episode', async () => {
    const t = await host((url) => {
      if (url.endsWith('ep1.ja.ass')) return new Response(fixtureBytes('subs/sample.ja.ass'));
      return new Response('nope', { status: 404 });
    });
    const root = 'file:///sdcard/Anime/Show';
    await t.fs.writeFile(`${root}/Show - 01.mkv`, new Uint8Array(4));
    const series = await t.host.anime.importSeries({ path: root });
    const [episode] = await t.host.anime.listEpisodes(series.id);
    if (!episode) throw new Error('no episode');
    const entry: JimakuEntry = { id: 77, name: 'Show', flags: { anime: true, unverified: false, external: false, movie: false, adult: false } };
    const file: JimakuFile = { entryId: 77, name: 'ep1.ja.ass', url: 'https://jimaku.cc/entry/77/download/ep1.ja.ass', extension: 'ass', isTextSubtitle: true, episode: 1 };
    const events: HostEvent[] = [];
    t.host.subscribe((e) => events.push(e));
    const task = await t.host.downloads.start({ source: { kind: 'jimaku', entry, file, episodeId: episode.id }, autoImport: true });
    const done = await waitFor(t.host, task.id, 'completed');
    expect(done.importedTrackId).toBeDefined();
    expect(events.some((e) => e.type === 'download-updated' && e.task.status === 'importing')).toBe(true);
    expect(events).toContainEqual({ type: 'library-changed', scope: 'anime' });
    const tracks = (await t.host.anime.getEpisode(episode.id)).subtitleTracks;
    expect(tracks).toEqual([expect.objectContaining({ id: done.importedTrackId, origin: 'jimaku', language: 'ja', isDefault: true })]);
    expect(tracks[0]?.filePath).toBe(`${t.deps.dataRoot}/subtitles/jimaku/77/ep1.ja.ass`);
    expect((await t.host.anime.getCues(done.importedTrackId ?? '')).cues[0]?.text).toBe('食べてんじゃねぇよ');
  });

  it('mokuro.moe volume: downloads .mokuro + archive, extracts and imports', async () => {
    const mokuro = fixtureText('mokuro-subfolder/Test Manga 第2巻.mokuro');
    const png = fixtureBytes('mokuro-subfolder/Test Manga 第2巻/001.png');
    const zip = zipSync({ 'Test Manga 第2巻/001.png': png, 'Test Manga 第2巻/002.png': png, 'Test Manga 第2巻/003.png': png });
    const t = await host((url) => (url.endsWith('.mokuro') ? new Response(mokuro) : new Response(zip.slice(), { headers: { 'content-length': String(zip.length) } })));
    const task = await t.host.downloads.start({
      source: { kind: 'mokuro-moe', volume: { name: 'Test Manga 第2巻', mokuroUrl: 'https://mokuro.moe/manga/T/v2.mokuro', imagesUrl: 'https://mokuro.moe/manga/T/v2.zip', imagesKind: 'archive' } },
      autoImport: true,
    });
    const done = await waitFor(t.host, task.id, 'completed');
    expect(done.kind).toBe('mokuro-volume');
    const volume = await t.host.manga.getVolume(done.importedVolumeId ?? '');
    expect(volume).toMatchObject({ kind: 'mokuro', pageCount: 3, hasOcr: true });
    const pages = await t.host.manga.getPages(volume.id);
    expect(pages[0]?.imageUrl).toContain('/manga/moe/Test Manga 第2巻/001.png');
    expect(await t.fs.stat(`${t.deps.dataRoot}/downloads/${task.id}.zip`)).toBeUndefined();
  });

  it('mokuro.moe volume: handles img_path folder prefix when volume name has sanitised chars', async () => {
    const png = fixtureBytes('mokuro-subfolder/Test Manga 第2巻/001.png');
    const mokuroJson = JSON.stringify({
      version: '0.2.5',
      title: 'Series: Special',
      volume: 'Series: Vol 01',
      pages: [
        { version: '0.2.5', img_width: 800, img_height: 1200, img_path: 'Series: Vol 01/01_#カバー.png', blocks: [] },
        { version: '0.2.5', img_width: 800, img_height: 1200, img_path: 'Series: Vol 01/02.png', blocks: [] },
      ],
    });
    const zip = zipSync({ 'Series: Vol 01/01_#カバー.png': png, 'Series: Vol 01/02.png': png });
    const t = await host((url) =>
      url.endsWith('.mokuro') ? new Response(mokuroJson) : new Response(zip.slice(), { headers: { 'content-length': String(zip.length) } }),
    );
    const task = await t.host.downloads.start({
      source: {
        kind: 'mokuro-moe',
        volume: {
          name: 'Series: Vol 01',
          mokuroUrl: 'https://mokuro.moe/mokuro-reader/Series/v1.mokuro',
          imagesUrl: 'https://mokuro.moe/mokuro-reader/Series/v1.cbz',
          imagesKind: 'archive',
        },
      },
      autoImport: true,
    });
    const done = await waitFor(t.host, task.id, 'completed');
    const volume = await t.host.manga.getVolume(done.importedVolumeId ?? '');
    expect(volume).toMatchObject({ kind: 'mokuro', pageCount: 2, hasOcr: true });
    const pages = await t.host.manga.getPages(volume.id);
    expect(pages[0]?.relativePath).toBe('01_#カバー.png');
    expect(pages[0]?.imageUrl).toContain('/manga/moe/Series_ Vol 01/01_');
  });

  it('torrent sources hand the magnet off to an external app (completed) and validate magnets', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const t = await host(() => new Response(''), { openExternal });
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Frieren';
    const task = await t.host.downloads.start({ source: { kind: 'torrent', infoHash: '0123456789abcdef0123456789abcdef01234567', magnet }, autoImport: true });
    expect(openExternal).toHaveBeenCalledWith(magnet);
    expect(task).toMatchObject({ kind: 'torrent', status: 'completed', progress: 1, targetDir: 'external' });
    await expect(t.host.downloads.selectFiles(task.id, [0])).rejects.toMatchObject({ code: 'unsupported' });

    const bad = await t.host.downloads.start({ source: { kind: 'torrent', infoHash: 'x', magnet: 'magnet:?dn=nohash' }, autoImport: false });
    expect(bad.status).toBe('failed');
    expect(openExternal).toHaveBeenCalledTimes(1);

    openExternal.mockRejectedValueOnce(new Error('No app can handle magnet links'));
    const noApp = await t.host.downloads.start({ source: { kind: 'torrent', infoHash: '0123456789abcdef0123456789abcdef01234567' }, autoImport: false });
    expect(noApp).toMatchObject({ status: 'failed', error: 'No app can handle magnet links' });
  });

  it('torrent sources use built-in Android torrent engine when present and auto-import anime', async () => {
    const t = await host(() => new Response(''), {
      torrent: {
        async start(req, onProgress) {
          await t.fs.writeFile(`${req.targetDir}/Frieren - 01.mkv`, new Uint8Array(64));
          queueMicrotask(() => {
            onProgress({
              taskId: req.taskId,
              status: 'downloading',
              progress: 0.5,
              downloadedBytes: 32,
              totalBytes: 64,
              speedBps: 1024,
              peers: 4,
              files: [{ index: 0, path: `${req.targetDir}/Frieren - 01.mkv`, sizeBytes: 64, downloadedBytes: 32, selected: true }],
            });
            onProgress({
              taskId: req.taskId,
              status: 'completed',
              progress: 1,
              downloadedBytes: 64,
              totalBytes: 64,
              speedBps: 0,
              peers: 4,
              files: [{ index: 0, path: `${req.targetDir}/Frieren - 01.mkv`, sizeBytes: 64, downloadedBytes: 64, selected: true }],
            });
          });
          return { stop: async () => undefined };
        },
      },
    });
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Frieren';
    const task = await t.host.downloads.start({
      source: { kind: 'torrent', infoHash: '0123456789abcdef0123456789abcdef01234567', magnet },
      title: 'Frieren',
      autoImport: true,
    });
    const done = await waitFor(t.host, task.id, 'completed');
    expect(done).toMatchObject({ kind: 'torrent', status: 'completed', progress: 1, downloadedBytes: 64, totalBytes: 64 });
    expect(done.importedSeriesId).toBeDefined();
    const series = await t.host.anime.getSeries(done.importedSeriesId ?? '');
    expect(series.episodeCount).toBe(1);
  });

  it('pause keeps the partial file; resume sends Range and appends on 206; cancel/remove clean up', async () => {
    let gate: (() => void) | undefined;
    const t = await host((_url, init) => {
      const range = new Headers(init?.headers).get('range');
      if (range) {
        const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0');
        const rest = payload.slice(from);
        return new Response(rest, { status: 206, headers: { 'content-length': String(rest.length) } });
      }
      // First attempt: deliver half, then hang until aborted.
      const half = payload.slice(0, 100_000);
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(half);
              return;
            }
            return new Promise<void>((resolve) => {
              gate = resolve;
            });
          },
        }),
        { headers: { 'content-length': String(payload.length) } },
      );
    });
    const task = await t.host.downloads.start({ source: { kind: 'http', url: 'https://example.com/a.bin' }, autoImport: false });
    await vi.waitFor(() => expect(gate).toBeDefined());
    const paused = await t.host.downloads.pause(task.id);
    gate?.();
    expect(paused.status).toBe('paused');
    const dest = `${t.deps.dataRoot}/downloads/a.bin`;
    // Buffered bytes are flushed on pause so resume can continue with `Range`.
    expect((await t.fs.stat(dest))?.sizeBytes).toBe(100_000);

    await t.host.downloads.resume(task.id);
    const done = await waitFor(t.host, task.id, 'completed');
    expect(sameBytes(await t.fs.readFile(dest), payload)).toBe(true);
    expect(done.status).toBe('completed');

    const events: HostEvent[] = [];
    t.host.subscribe((e) => events.push(e));
    await t.host.downloads.remove(task.id, true);
    expect(events).toContainEqual({ type: 'download-removed', taskId: task.id });
    expect(await t.fs.stat(dest)).toBeUndefined();
    await expect(t.host.downloads.get(task.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('failed HTTP marks the task failed; cancel of a queued task removes partial output', async () => {
    const t = await host(() => new Response('gone', { status: 410 }));
    const task = await t.host.downloads.start({ source: { kind: 'http', url: 'https://example.com/x.zip' }, autoImport: true });
    const failed = await waitFor(t.host, task.id, 'failed');
    expect(failed.error).toContain('410');
    const cancelled = await t.host.downloads.cancel(task.id);
    expect(cancelled.status).toBe('failed');
  });

  it('search APIs go through fetch + core parsers', async () => {
    const t = await host((url) => {
      if (url.startsWith('https://nyaa.si/')) return new Response(fixtureText('nyaa.xml'));
      if (url.startsWith('https://mokuro.moe/')) return new Response(fixtureText('mokuro-moe.html'));
      if (url.includes('/api/entries/search')) return Response.json([{ id: 5, name: 'Sousou no Frieren', flags: { anime: true } }]);
      if (url.includes('/api/entries/5/files')) return Response.json([{ name: 'Frieren - 01.ass', url: 'https://jimaku.cc/f/1.ass', size: 10, last_modified: '2024-01-01T00:00:00Z' }]);
      return new Response('', { status: 404 });
    });
    const items = await t.host.downloads.searchNyaa({ query: 'frieren' });
    expect(t.urls[0]).toContain('q=frieren');
    expect(items[0]).toMatchObject({ infoHash: '0123456789abcdef0123456789abcdef01234567', seeders: 120, trusted: true });
    expect(items[0]?.magnet).toMatch(/^magnet:\?xt=urn:btih:0123456789abcdef/);

    const listing = await t.host.downloads.browseMokuroCatalog();
    expect(t.urls[1]).toBe('https://mokuro.moe/catalog/api/library');
    expect(listing.volumes.map((v) => [v.name, v.imagesKind])).toEqual([
      ['Test v01', 'dir'],
      ['Test v02', 'archive'],
    ]);

    await expect(t.host.downloads.searchJimaku({ query: 'frieren' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await t.host.settings.update({ anime: { jimakuApiKey: 'jk' } });
    const entries = await t.host.downloads.searchJimaku({ query: 'frieren' });
    expect(entries[0]).toMatchObject({ id: 5, name: 'Sousou no Frieren' });
    expect(new Headers(t.inits.at(-1)?.headers).get('authorization')).toBe('jk');
    const files = await t.host.downloads.listJimakuFiles(5);
    expect(files[0]).toMatchObject({ name: 'Frieren - 01.ass', isTextSubtitle: true, episode: 1 });
  });

  it('autoFetchJimaku queues one download per matched episode', async () => {
    const t = await host((url) => {
      if (url.includes('/api/entries/search')) return Response.json([{ id: 9, name: 'Show', flags: { anime: true } }]);
      if (url.includes('/api/entries/9/files')) {
        return Response.json([
          { name: 'Show - 01.srt', url: 'https://jimaku.cc/f/01.srt' },
          { name: 'Show - 01.ass', url: 'https://jimaku.cc/f/01.ass' },
          { name: 'Show - 03.ass', url: 'https://jimaku.cc/f/03.ass' },
        ]);
      }
      if (url.endsWith('01.ass')) return new Response(fixtureBytes('subs/sample.ja.ass'));
      return new Response('', { status: 404 });
    });
    const root = 'file:///sdcard/Anime/Show';
    await loadFixtureDir(t.fs, 'subs', `${root}/unused`);
    await t.fs.writeFile(`${root}/Show - 01.mkv`, new Uint8Array(4));
    await t.fs.writeFile(`${root}/Show - 02.mkv`, new Uint8Array(4));
    await t.host.settings.update({ anime: { jimakuApiKey: 'jk' } });
    const series = await t.host.anime.importSeries({ path: root });
    const tasks = await t.host.anime.autoFetchJimaku(series.id);
    expect(tasks.map((x) => x.title)).toEqual(['Show - 01.ass']);
    await waitFor(t.host, tasks[0]?.id ?? '', 'completed');
    expect((await t.host.anime.getSeries(series.id)).jimakuEntryId).toBe(9);
  });

  it('restores persisted tasks; interrupted ones come back paused', async () => {
    const t = await host(() => new Response(pngHeader(1, 1)));
    const task = await t.host.downloads.start({ source: { kind: 'http', url: 'https://example.com/p.png' }, autoImport: false });
    await waitFor(t.host, task.id, 'completed');
    await t.host.dispose();
    const again = await createTestHost({}, { fs: t.fs, idbFactory: t.idbFactory, clock: t.clock });
    open.push(again);
    expect((await again.host.downloads.get(task.id)).status).toBe('completed');
  });
});
