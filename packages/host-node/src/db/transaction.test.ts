import { describe, expect, it } from 'vitest';
import { createRepositories } from './repositories';
import { openDatabase, transaction } from './sqlite';

describe('transaction()', () => {
  it('nests via savepoints: inner failure rolls back only the inner block', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    transaction(db, () => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      expect(() =>
        transaction(db, () => {
          db.prepare('INSERT INTO t VALUES (2)').run();
          throw new Error('inner');
        }),
      ).toThrow('inner');
      db.prepare('INSERT INTO t VALUES (3)').run();
    });
    expect((db.prepare('SELECT x FROM t ORDER BY x').all() as Array<{ x: number }>).map((r) => r.x)).toEqual([1, 3]);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it('pages.replaceAll is atomic (old pages survive a failing replacement)', () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db);
    repos.volumes.upsert({ id: 'v', title: 'V', kind: 'images', sourcePath: '/v', rootDir: '/v', pageCount: 1, hasOcr: false, coverIsSingle: true, addedAt: 1 });
    repos.pages.replaceAll('v', [{ index: 0, relativePath: 'old.png', width: 1, height: 1, blocks: [] }]);
    expect(() =>
      repos.pages.replaceAll('v', [
        { index: 0, relativePath: 'a.png', width: 1, height: 1, blocks: [] },
        { index: 0, relativePath: 'dup.png', width: 1, height: 1, blocks: [] },
      ]),
    ).toThrow(/UNIQUE/);
    expect(repos.pages.list('v').map((p) => p.relativePath)).toEqual(['old.png']);
    db.close();
  });

  it('download auto-import flag persists and is kept when omitted on update', () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db);
    const task = { id: 'd', kind: 'http-file', source: { kind: 'http', url: 'https://x/y' }, title: 'y', status: 'queued', progress: 0, downloadedBytes: 0, speedBps: 0, targetDir: '/t', createdAt: 1, updatedAt: 1 } as const;
    repos.downloads.put(task, true);
    expect(repos.downloads.autoImport('d')).toBe(true);
    repos.downloads.put({ ...task, status: 'downloading' });
    expect(repos.downloads.autoImport('d')).toBe(true);
    repos.downloads.put(task, false);
    expect(repos.downloads.autoImport('d')).toBe(false);
    expect(repos.downloads.autoImport('missing')).toBe(false);
    db.close();
  });
});
