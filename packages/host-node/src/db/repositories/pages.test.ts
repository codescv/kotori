import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MangaBlock } from '@kotori/core';
import { openDatabase, type Database } from '../sqlite';
import { createRepositories, type PageRecord, type Repositories } from './index';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

type Backend = 'memory' | 'file';

function open(backend: Backend): Repositories {
  let path = ':memory:';
  if (backend === 'file') {
    const dir = mkdtempSync(join(tmpdir(), 'kotori-pages-test-'));
    tmpDirs.push(dir);
    path = join(dir, 'kotori.db');
  }
  const db = openDatabase(path);
  dbs.push(db);
  const repos = createRepositories(db);
  repos.volumes.upsert({
    id: 'v1',
    title: 'Vol 1',
    kind: 'mokuro',
    sourcePath: '/manga/v1',
    rootDir: '/manga/v1',
    pageCount: 2,
    hasOcr: true,
    coverIsSingle: true,
    addedAt: 1,
  });
  return repos;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const block: MangaBlock = {
  index: 0,
  rect: { left: 1, top: 2, right: 30, bottom: 40 },
  vertical: true,
  fontSize: 18,
  zIndex: 0,
  lines: ['こんにちは', '世界'],
  text: 'こんにちは世界',
  linesCoords: [
    [
      [1, 2],
      [3, 4],
    ],
  ],
  regions: [{ rect: { left: 1, top: 2, right: 3, bottom: 4 }, utf16Start: 0, utf16End: 1, rotation: 0.1 }],
  source: 'mokuro',
  confidence: 0.9,
};

const pages: PageRecord[] = [
  { index: 1, relativePath: 'img/p1.jpg', width: 800.4, height: 1200.6, blocks: [] },
  { index: 0, relativePath: 'img/p0.jpg', width: 800, height: 1200, blocks: [block] },
];

describe.each<Backend>(['memory', 'file'])('PageRepository (%s db)', (backend) => {
  it('replaceAll stores pages (rounded sizes, blocks JSON) and lists them in index order', () => {
    const repos = open(backend);
    repos.pages.replaceAll('v1', pages);
    expect(repos.pages.list('v1')).toEqual([
      { index: 0, relativePath: 'img/p0.jpg', width: 800, height: 1200, blocks: [block], imageUrl: '/api/manga/volumes/v1/pages/0/image' },
      { index: 1, relativePath: 'img/p1.jpg', width: 800, height: 1201, blocks: [], imageUrl: '/api/manga/volumes/v1/pages/1/image' },
    ]);
    expect(repos.pages.get('v1', 0)?.blocks[0]).toEqual(block);
    expect(repos.pages.get('v1', 5)).toBeUndefined();
    expect(repos.pages.relativePath('v1', 1)).toBe('img/p1.jpg');
    expect(repos.pages.relativePath('v1', 9)).toBeUndefined();
    expect(repos.pages.list('other')).toEqual([]);
  });

  it('replaceAll replaces the previous page set entirely', () => {
    const repos = open(backend);
    repos.pages.replaceAll('v1', pages);
    repos.pages.replaceAll('v1', [{ index: 0, relativePath: 'new.png', width: 1, height: 1, blocks: [] }]);
    expect(repos.pages.list('v1').map((p) => p.relativePath)).toEqual(['new.png']);
    repos.pages.replaceAll('v1', []);
    expect(repos.pages.list('v1')).toEqual([]);
  });

  it('setBlocks and setSize update one page', () => {
    const repos = open(backend);
    repos.pages.replaceAll('v1', pages);
    repos.pages.setBlocks('v1', 1, [{ ...block, index: 0, source: 'vlm' }]);
    repos.pages.setSize('v1', 1, 640, 480);
    expect(repos.pages.get('v1', 1)).toMatchObject({ width: 640, height: 480, blocks: [{ source: 'vlm', text: 'こんにちは世界' }] });
    expect(repos.pages.get('v1', 0)?.blocks).toEqual([block]);
  });

  it('rejects pages for a missing volume (foreign key)', () => {
    const repos = open(backend);
    expect(() => repos.pages.replaceAll('ghost', pages)).toThrow(/FOREIGN KEY/);
  });

  it('url-encodes the volume id in imageUrl', () => {
    const repos = open(backend);
    repos.volumes.upsert({
      id: 'a/b c',
      title: 'x',
      kind: 'images',
      sourcePath: '/x',
      rootDir: '/x',
      pageCount: 1,
      hasOcr: false,
      coverIsSingle: true,
      addedAt: 1,
    });
    repos.pages.replaceAll('a/b c', [{ index: 0, relativePath: 'p.jpg', width: 1, height: 1, blocks: [] }]);
    expect(repos.pages.get('a/b c', 0)?.imageUrl).toBe('/api/manga/volumes/a%2Fb%20c/pages/0/image');
  });
});
