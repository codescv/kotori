import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DownloadTask } from '@kotori/core';
import { openDatabase, type Database } from '../sqlite';
import { DownloadRepository } from './downloads';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

type Backend = 'memory' | 'file';

function openPath(backend: Backend): string {
  if (backend === 'memory') return ':memory:';
  const dir = mkdtempSync(join(tmpdir(), 'kotori-downloads-test-'));
  tmpDirs.push(dir);
  return join(dir, 'kotori.db');
}

function open(path: string): { db: Database; repo: DownloadRepository } {
  const db = openDatabase(path);
  dbs.push(db);
  return { db, repo: new DownloadRepository(db) };
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const torrentTask: DownloadTask = {
  id: 'd1',
  kind: 'torrent',
  source: { kind: 'torrent', infoHash: 'abcdef0123456789abcdef0123456789abcdef01', magnet: 'magnet:?xt=urn:btih:abc', fileIndexes: [0, 2] },
  title: '[Group] Show (01-12) 「日本語」',
  status: 'downloading',
  progress: 0.25,
  downloadedBytes: 1024,
  totalBytes: 4096,
  speedBps: 512,
  uploadSpeedBps: 64,
  peers: 7,
  seeds: 3,
  etaMs: 6_000,
  files: [
    { index: 0, path: 'Show/01.mkv', sizeBytes: 2048, downloadedBytes: 1024, selected: true },
    { index: 1, path: 'Show/extra.txt', sizeBytes: 0, downloadedBytes: 0, selected: false },
  ],
  targetDir: '/downloads',
  createdAt: 100,
  updatedAt: 200,
};

const httpTask: DownloadTask = {
  id: 'd2',
  kind: 'http-file',
  source: { kind: 'http', url: 'https://example.com/a.zip', fileName: 'a.zip' },
  title: 'a.zip',
  status: 'queued',
  progress: 0,
  downloadedBytes: 0,
  speedBps: 0,
  targetDir: '/downloads',
  createdAt: 300,
  updatedAt: 300,
};

describe.each<Backend>(['memory', 'file'])('DownloadRepository (%s db)', (backend) => {
  it('round-trips the full task JSON (nested source union, files, unicode)', () => {
    const { repo } = open(openPath(backend));
    repo.put(torrentTask);
    expect(repo.get('d1')).toEqual(torrentTask);
    expect(repo.get('missing')).toBeUndefined();
  });

  it('lists newest created first', () => {
    const { repo } = open(openPath(backend));
    repo.put(torrentTask);
    repo.put(httpTask);
    expect(repo.list().map((t) => t.id)).toEqual(['d2', 'd1']);
  });

  it('put on an existing id updates json, status and created_at columns consistently', () => {
    const { db, repo } = open(openPath(backend));
    repo.put(torrentTask);
    const done: DownloadTask = { ...torrentTask, status: 'completed', progress: 1, createdAt: 999, updatedAt: 500, completedAt: 500, importedSeriesId: 's1' };
    repo.put(done);
    expect(repo.list()).toHaveLength(1);
    expect(repo.get('d1')).toEqual(done);
    expect(db.prepare('SELECT kind, status, created_at, updated_at FROM download_tasks WHERE id = ?').get('d1')).toEqual({
      kind: 'torrent',
      status: 'completed',
      created_at: 999,
      updated_at: 500,
    });
  });

  it('remove() reports whether a row was deleted', () => {
    const { repo } = open(openPath(backend));
    repo.put(httpTask);
    expect(repo.remove('d2')).toBe(true);
    expect(repo.remove('d2')).toBe(false);
    expect(repo.list()).toEqual([]);
  });
});

describe('DownloadRepository persistence', () => {
  it('tasks survive closing and re-opening a file database', () => {
    const path = openPath('file');
    const first = open(path);
    first.repo.put(torrentTask);
    first.repo.put(httpTask);
    first.db.close();
    const second = open(path);
    expect(second.repo.list()).toEqual([httpTask, torrentTask]);
  });
});
