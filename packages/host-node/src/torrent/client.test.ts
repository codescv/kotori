import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TorrentClient } from './client';
import { createTorrentFile, parseTorrentFile } from './metainfo';
import type { Torrent } from './torrent';
import type { TorrentStatus } from './types';

/** Deterministic pseudo-random bytes. */
function payload(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

const MiB = 1024 * 1024;
// 2 MiB multi-file payload with boundaries that do not align to pieces.
const FILES = [
  { path: 'Show/Episode 01.mkv', data: payload(1_200_000, 11) },
  { path: 'Show/Episode 01.ja.ass', data: payload(12_345, 12) },
  { path: 'Show/empty.txt', data: new Uint8Array(0) },
  { path: 'extras/cover.jpg', data: payload(2 * MiB - 1_200_000 - 12_345, 13) },
];
const NAME = 'Kotori Test Pack';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `kotori-${prefix}-`));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

async function newClient(): Promise<TorrentClient> {
  const client = new TorrentClient({ dataDir: await tmp('data'), dht: false, trackers: false });
  cleanups.push(() => client.destroy());
  await client.listen();
  return client;
}

/** Writes the payload into `{dir}/{NAME}/…` and returns the .torrent bytes. */
async function prepareSeedData(dir: string, pieceLength: number): Promise<Uint8Array> {
  for (const f of FILES) {
    const p = join(dir, NAME, ...f.path.split('/'));
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, f.data);
  }
  return createTorrentFile({ name: NAME, files: FILES, pieceLength });
}

function waitFor(t: Torrent, status: TorrentStatus, timeoutMs = 20_000): Promise<void> {
  if (t.status === status) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${status}; status=${t.status}`)), timeoutMs);
    const onStatus = (s: TorrentStatus): void => {
      if (s !== status) return;
      clearTimeout(timer);
      t.off('status', onStatus);
      resolve();
    };
    t.on('status', onStatus);
  });
}

async function startSeeder(pieceLength: number): Promise<{ seeder: TorrentClient; torrentBytes: Uint8Array; seed: Torrent }> {
  const seeder = await newClient();
  const seedDir = await tmp('seed');
  const torrentBytes = await prepareSeedData(seedDir, pieceLength);
  const seed = await seeder.add({ torrentFile: torrentBytes }, { downloadDir: seedDir, seedAfterComplete: true });
  await waitFor(seed, 'seeding');
  expect(seed.stats().progress).toBe(1);
  return { seeder, torrentBytes, seed };
}

async function expectIdenticalFiles(downloadDir: string): Promise<void> {
  for (const f of FILES) {
    const got = new Uint8Array(await readFile(join(downloadDir, NAME, ...f.path.split('/'))));
    expect(got.length).toBe(f.data.length);
    expect(Buffer.from(got).equals(Buffer.from(f.data))).toBe(true);
  }
}

describe('TorrentClient integration (loopback, offline)', () => {
  it('downloads a 2 MiB multi-file torrent from an in-process seeder', async () => {
    const { seeder, torrentBytes } = await startSeeder(64 * 1024);
    const leecher = await newClient();
    const downloadDir = await tmp('leech');

    const events: string[] = [];
    const t = await leecher.add(
      { torrentFile: torrentBytes },
      { downloadDir, peers: [{ host: '127.0.0.1', port: seeder.port }] },
    );
    t.on('done', () => events.push('done'));
    t.on('metadata', () => events.push('metadata'));
    expect(t.infoHash).toBe(parseTorrentFile(torrentBytes).infoHash);
    expect(t.name).toBe(NAME);
    expect(t.files.map((f) => f.path)).toEqual(FILES.map((f) => `${NAME}/${f.path}`));

    await waitFor(t, 'completed');
    expect(events).toContain('done');
    const stats = t.stats();
    expect(stats.progress).toBe(1);
    expect(stats.downloadedBytes).toBe(2 * MiB);
    expect(stats.totalBytes).toBe(2 * MiB);
    expect(t.files.every((f) => f.downloaded === f.length && f.selected)).toBe(true);
    await expectIdenticalFiles(downloadDir);
    expect((await stat(join(downloadDir, NAME, 'Show/empty.txt'))).size).toBe(0);

    // Resume: a fresh client over the same dataDir/downloadDir is instantly complete.
    await leecher.remove(t.infoHash);
    expect(leecher.get(t.infoHash)).toBeUndefined();
    const t2 = await leecher.add({ torrentFile: torrentBytes }, { downloadDir });
    await waitFor(t2, 'completed');
    expect(t2.stats().progress).toBe(1);
  }, 30_000);

  it('resolves a magnet via ut_metadata and downloads the payload', async () => {
    const { seeder, seed } = await startSeeder(32 * 1024);
    const leecher = await newClient();
    const downloadDir = await tmp('leech');

    const t = await leecher.add(
      { magnet: `magnet:?xt=urn:btih:${seed.infoHash}&dn=whatever` },
      { downloadDir, peers: [{ host: '127.0.0.1', port: seeder.port }] },
    );
    expect(t.status).toBe('resolving');
    expect(t.name).toBe('whatever');
    expect(t.files).toEqual([]);
    const gotMetadata = new Promise<void>((r) => t.once('metadata', () => r()));

    await gotMetadata;
    expect(t.name).toBe(NAME);
    expect(t.files).toHaveLength(FILES.length);
    expect(t.torrentFile()).toBeInstanceOf(Uint8Array);
    await waitFor(t, 'completed');
    await expectIdenticalFiles(downloadDir);
  }, 30_000);

  it('downloads only the selected files and supports pause/resume', async () => {
    const { seeder, torrentBytes } = await startSeeder(64 * 1024);
    const leecher = await newClient();
    const downloadDir = await tmp('leech');
    const t = await leecher.add(
      { torrentFile: torrentBytes },
      { downloadDir, fileIndexes: [1], peers: [{ host: '127.0.0.1', port: seeder.port }] },
    );
    t.pause();
    expect(t.status).toBe('paused');
    t.resume();
    await waitFor(t, 'completed');
    const files = t.files;
    expect(files.map((f) => f.selected)).toEqual([false, true, false, false]);
    expect(files[1]?.downloaded).toBe(FILES[1]?.data.length);
    expect(t.stats().totalBytes).toBe(FILES[1]?.data.length);
    const sub = new Uint8Array(await readFile(join(downloadDir, NAME, 'Show/Episode 01.ja.ass')));
    expect(Buffer.from(sub).equals(Buffer.from(FILES[1]!.data))).toBe(true);
    // Only the boundary piece touches neighbours; the rest of the unselected files was never fetched.
    expect(files[0]!.downloaded).toBeLessThan(files[0]!.length);
    expect(files[3]!.downloaded).toBeLessThan(files[3]!.length);
    expect(t.stats().downloadedBytes).toBe(FILES[1]?.data.length);
  }, 30_000);

  it('swarms between three peers and honours the download limit', async () => {
    const { seeder, torrentBytes } = await startSeeder(32 * 1024);
    const a = await newClient();
    const dirA = await tmp('leech-a');
    const ta = await a.add(
      { torrentFile: torrentBytes },
      { downloadDir: dirA, seedAfterComplete: true, peers: [{ host: '127.0.0.1', port: seeder.port }] },
    );
    const b = new TorrentClient({ dataDir: await tmp('data-b'), dht: false, trackers: false, downloadLimitBps: 1024 * 1024 });
    cleanups.push(() => b.destroy());
    const dirB = await tmp('leech-b');
    const started = Date.now();
    const tb = await b.add(
      { torrentFile: torrentBytes },
      { downloadDir: dirB, peers: [{ host: '127.0.0.1', port: a.port }, { host: '127.0.0.1', port: seeder.port }] },
    );
    await waitFor(ta, 'seeding');
    await waitFor(tb, 'completed');
    // 2 MiB at 1 MiB/s with a 1 MiB burst ⇒ at least ~1 s.
    expect(Date.now() - started).toBeGreaterThan(800);
    await expectIdenticalFiles(dirA);
    await expectIdenticalFiles(dirB);
  }, 30_000);

  it('rejects bad input and deduplicates by info hash', async () => {
    const client = await newClient();
    const dir = await tmp('x');
    await expect(client.add({}, { downloadDir: dir })).rejects.toThrow();
    await expect(client.add({ magnet: 'magnet:?dn=nope' }, { downloadDir: dir })).rejects.toThrow();
    await expect(client.add({ infoHash: 'zz' }, { downloadDir: dir })).rejects.toThrow();
    const hash = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
    const a = await client.add({ infoHash: hash }, { downloadDir: dir });
    const b = await client.add({ magnet: `magnet:?xt=urn:btih:${hash}` }, { downloadDir: dir });
    expect(a).toBe(b);
    expect(client.list()).toHaveLength(1);
    expect(client.port).toBeGreaterThan(0);
    await client.remove(hash, { deleteFiles: true });
    expect(client.list()).toHaveLength(0);
  });
});
