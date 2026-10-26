import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../sqlite';
import { createRepositories, type Repositories, type VolumeRecord } from './index';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

type Backend = 'memory' | 'file';

function open(backend: Backend): { db: Database; repos: Repositories } {
  let path = ':memory:';
  if (backend === 'file') {
    const dir = mkdtempSync(join(tmpdir(), 'kotori-volumes-test-'));
    tmpDirs.push(dir);
    path = join(dir, 'kotori.db');
  }
  const db = openDatabase(path);
  dbs.push(db);
  return { db, repos: createRepositories(db) };
}

function count(db: Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vol(over: Partial<VolumeRecord> = {}): VolumeRecord {
  return {
    id: 'v1',
    title: 'Vol 1',
    kind: 'mokuro',
    sourcePath: '/manga/v1.mokuro',
    rootDir: '/manga/v1',
    pageCount: 3,
    hasOcr: true,
    coverIsSingle: true,
    addedAt: 100,
    ...over,
  };
}

describe.each<Backend>(['memory', 'file'])('VolumeRepository (%s db)', (backend) => {
  it('round-trips a volume with booleans, cover URL and no null optionals', () => {
    const { repos } = open(backend);
    repos.volumes.upsert(vol({ id: 'v 1/x' }));
    const got = repos.volumes.get('v 1/x');
    expect(got).toEqual({
      id: 'v 1/x',
      title: 'Vol 1',
      kind: 'mokuro',
      sourcePath: '/manga/v1.mokuro',
      pageCount: 3,
      hasOcr: true,
      coverIsSingle: true,
      addedAt: 100,
      coverUrl: '/api/manga/volumes/v%201%2Fx/pages/0/image',
    });
    expect(got && ('seriesTitle' in got || 'volumeNumber' in got || 'readingMode' in got || 'progress' in got)).toBe(false);
    expect(repos.volumes.get('missing')).toBeUndefined();
  });

  it('omits coverUrl for an empty volume and maps false booleans / optionals', () => {
    const { repos } = open(backend);
    repos.volumes.upsert(vol({ pageCount: 0, hasOcr: false, coverIsSingle: false, kind: 'images', seriesTitle: 'S', volumeNumber: 1.5 }));
    const got = repos.volumes.get('v1');
    expect(got).toMatchObject({ pageCount: 0, hasOcr: false, coverIsSingle: false, kind: 'images', seriesTitle: 'S', volumeNumber: 1.5 });
    expect(got && 'coverUrl' in got).toBe(false);
  });

  it('upsert updates metadata but keeps reading mode, cover flag, added_at and progress', () => {
    const { repos } = open(backend);
    repos.volumes.upsert(vol({ managedDir: '/managed/v1' }));
    repos.volumes.setReadingMode('v1', 'single-ltr');
    repos.volumes.setCoverIsSingle('v1', false);
    repos.volumes.saveProgress('v1', { pageIndex: 2, updatedAt: 50 });
    repos.volumes.upsert(vol({ title: 'Renamed', pageCount: 10, hasOcr: false, coverIsSingle: true, addedAt: 999, rootDir: '/new/root' }));
    expect(repos.volumes.get('v1')).toMatchObject({
      title: 'Renamed',
      pageCount: 10,
      hasOcr: false,
      coverIsSingle: false,
      addedAt: 100,
      readingMode: 'single-ltr',
      progress: { pageIndex: 2, updatedAt: 50 },
    });
    // managed_dir is overwritten (cleared when absent), root_dir updated.
    expect(repos.volumes.locations('v1')).toEqual({ rootDir: '/new/root', sourcePath: '/manga/v1.mokuro' });
  });

  it('locations() includes managedDir only when set', () => {
    const { repos } = open(backend);
    repos.volumes.upsert(vol({ managedDir: '/managed/v1' }));
    expect(repos.volumes.locations('v1')).toEqual({ rootDir: '/manga/v1', sourcePath: '/manga/v1.mokuro', managedDir: '/managed/v1' });
    expect(repos.volumes.locations('missing')).toBeUndefined();
  });

  it('setters: reading mode set/clear, hasOcr, cover flag; progress upserts', () => {
    const { repos } = open(backend);
    repos.volumes.upsert(vol({ hasOcr: false }));
    repos.volumes.setReadingMode('v1', 'spread-rtl');
    repos.volumes.setHasOcr('v1', true);
    repos.volumes.setCoverIsSingle('v1', false);
    repos.volumes.saveProgress('v1', { pageIndex: 1, updatedAt: 1 });
    repos.volumes.saveProgress('v1', { pageIndex: 2, updatedAt: 2 });
    expect(repos.volumes.get('v1')).toMatchObject({ readingMode: 'spread-rtl', hasOcr: true, coverIsSingle: false, progress: { pageIndex: 2, updatedAt: 2 } });
    repos.volumes.setReadingMode('v1', undefined);
    const got = repos.volumes.get('v1');
    expect(got && 'readingMode' in got).toBe(false);
  });

  it('saveProgress for an unknown volume violates the foreign key', () => {
    const { repos } = open(backend);
    expect(() => repos.volumes.saveProgress('ghost', { pageIndex: 0, updatedAt: 0 })).toThrow(/FOREIGN KEY/);
  });

  it('lists by series title (falling back to title), then volume number, then title', () => {
    const { repos } = open(backend);
    repos.volumes.upsert(vol({ id: 'b2', title: 'B v2', seriesTitle: 'B', volumeNumber: 2, sourcePath: '/b2' }));
    repos.volumes.upsert(vol({ id: 'b1', title: 'B v1', seriesTitle: 'B', volumeNumber: 1, sourcePath: '/b1' }));
    repos.volumes.upsert(vol({ id: 'a', title: 'A oneshot', sourcePath: '/a' }));
    repos.volumes.upsert(vol({ id: 'c', title: 'C', seriesTitle: 'C', volumeNumber: 1, sourcePath: '/c' }));
    expect(repos.volumes.list().map((v) => v.id)).toEqual(['a', 'b1', 'b2', 'c']);
  });

  it('remove() cascades to pages and progress of that volume only', () => {
    const { db, repos } = open(backend);
    repos.volumes.upsert(vol());
    repos.volumes.upsert(vol({ id: 'v2', sourcePath: '/manga/v2' }));
    for (const id of ['v1', 'v2']) {
      repos.pages.replaceAll(id, [
        { index: 0, relativePath: 'p0.jpg', width: 10, height: 20, blocks: [] },
        { index: 1, relativePath: 'p1.jpg', width: 10, height: 20, blocks: [] },
      ]);
      repos.volumes.saveProgress(id, { pageIndex: 1, updatedAt: 1 });
    }
    expect(repos.volumes.remove('v1')).toBe(true);
    expect(repos.volumes.remove('v1')).toBe(false);
    expect(repos.pages.list('v1')).toEqual([]);
    expect(count(db, 'manga_pages')).toBe(2);
    expect(count(db, 'manga_progress')).toBe(1);
    expect(repos.volumes.get('v2')?.progress).toEqual({ pageIndex: 1, updatedAt: 1 });
  });
});
