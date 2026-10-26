import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importArchive, importImageDir, importManga, importMokuro } from './manga-importer';

let root: string;
let managedDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotori-manga-'));
  managedDir = join(root, 'managed', 'vol-1');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Minimal PNG header (signature + IHDR) — enough for `readImageSize`. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

/** Minimal JPEG: SOI + SOF0 segment carrying height/width. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

async function put(rel: string, content: string | Uint8Array): Promise<string> {
  const full = join(root, ...rel.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  return full;
}

/** A `.mokuro` document with two pages; page 2 has no stored size (sniffed from the file). */
function mokuroJson(imgPaths: readonly [string, string], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0.2.1',
    title: 'Yotsuba',
    title_uuid: 't-1',
    volume: 'Yotsuba 01',
    volume_uuid: 'v-1',
    pages: [
      {
        img_path: imgPaths[0],
        img_width: 1000,
        img_height: 1500,
        blocks: [{ box: [10, 20, 110, 220], vertical: true, font_size: 24, lines: ['よつばと', '！'] }],
      },
      { img_path: imgPaths[1], blocks: [] },
    ],
    ...extra,
  });
}

describe('importMokuro', () => {
  it('reads images beside the .mokuro', async () => {
    const path = await put('lib/Yotsuba v01.mokuro', mokuroJson(['001.jpg', '002.png']));
    await put('lib/001.jpg', jpeg(1000, 1500));
    await put('lib/002.png', png(640, 960));
    const vol = await importMokuro(path, { managedDir });
    expect(vol).toMatchObject({
      kind: 'mokuro',
      title: 'Yotsuba 01',
      seriesTitle: 'Yotsuba',
      volumeNumber: 1,
      sourcePath: path,
      rootDir: join(root, 'lib'),
      hasOcr: true,
      warnings: [],
    });
    expect(vol).not.toHaveProperty('managedDir');
    expect(vol.pages).toHaveLength(2);
    expect(vol.pages[0]).toMatchObject({ index: 0, relativePath: '001.jpg', width: 1000, height: 1500 });
    expect(vol.pages[0]?.blocks[0]).toMatchObject({ vertical: true, fontSize: 24, lines: ['よつばと', '！'], text: 'よつばと！' });
    expect(vol.pages[1]).toMatchObject({ index: 1, relativePath: '002.png', width: 640, height: 960, blocks: [] });
    expect(existsSync(managedDir)).toBe(false);
  });

  it('reads images from a same-named sub-folder', async () => {
    const path = await put('lib/Vol 3.mokuro', mokuroJson(['p1.png', 'p2.png']));
    await put('lib/Vol 3/p1.png', png(10, 20));
    await put('lib/Vol 3/p2.png', png(30, 40));
    const vol = await importMokuro(path, { managedDir });
    expect(vol.rootDir).toBe(join(root, 'lib', 'Vol 3'));
    expect(vol.pages.map((p) => [p.width, p.height])).toEqual([
      [1000, 1500],
      [30, 40],
    ]);
    expect(vol.warnings).toEqual([]);
  });

  it('extracts images from a same-named .zip into managedDir', async () => {
    const path = await put('lib/Vol 4.mokuro', mokuroJson(['p1.png', 'p2.png']));
    await put('lib/Vol 4.zip', zipSync({ 'p1.png': png(1, 2), 'p2.png': png(3, 4) }));
    const vol = await importMokuro(path, { managedDir });
    expect(vol.managedDir).toBe(managedDir);
    expect(vol.rootDir).toBe(managedDir);
    expect(vol.pages[1]).toMatchObject({ width: 3, height: 4 });
    expect(await readFile(join(managedDir, 'p2.png'))).toEqual(Buffer.from(png(3, 4)));
  });

  it('handles archives that nest pages inside a {volumeName}/ folder (.cbz preferred)', async () => {
    const path = await put('lib/Vol 5.mokuro', mokuroJson(['p1.png', 'p2.png']));
    await put('lib/Vol 5.cbz', zipSync({ 'Vol 5': { 'p1.png': png(1, 1), 'p2.png': png(5, 6) } }));
    await put('lib/Vol 5.zip', 'not a zip — must not be read when the .cbz exists');
    const vol = await importMokuro(path, { managedDir });
    expect(vol.rootDir).toBe(join(managedDir, 'Vol 5'));
    expect(vol.pages[1]).toMatchObject({ width: 5, height: 6 });
    expect(vol.warnings).toEqual([]);
  });

  it('warns about missing page images and keeps zero sizes', async () => {
    const path = await put('lib/V.mokuro', mokuroJson(['a.png', 'b.png']));
    await put('lib/a.png', png(1, 1));
    const vol = await importMokuro(path, { managedDir });
    expect(vol.warnings).toEqual(['missing page image b.png']);
    expect(vol.pages[1]).toMatchObject({ width: 0, height: 0 });
  });

  it('honours titleOverride and falls back to the file name when the doc has no volume', async () => {
    const json = JSON.stringify({ pages: [{ img_path: 'a.png', img_width: 1, img_height: 1 }] });
    const path = await put('lib/Some Series 第2巻.mokuro', json);
    await put('lib/a.png', png(1, 1));
    const plain = await importMokuro(path, { managedDir });
    expect(plain).toMatchObject({ title: 'Some Series 第2巻', seriesTitle: 'Some Series', volumeNumber: 2 });
    const overridden = await importMokuro(path, { managedDir, titleOverride: 'Custom' });
    expect(overridden.title).toBe('Custom');
  });

  it('rejects invalid JSON with a parse error', async () => {
    const path = await put('lib/bad.mokuro', '{not json');
    await expect(importMokuro(path, { managedDir })).rejects.toMatchObject({ name: 'KotoriError', code: 'parse' });
  });

  it('rejects when page images cannot be found anywhere', async () => {
    const path = await put('lib/Lost.mokuro', mokuroJson(['a.png', 'b.png']));
    await expect(importMokuro(path, { managedDir })).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('importArchive', () => {
  it('extracts images in natural order, skipping __MACOSX, dot-files, non-images and zip-slip entries', async () => {
    const path = await put('in/Series v02.cbz', zipSync({
      'Series v02': { '10.png': png(10, 10), '2.png': png(2, 2), '1.jpg': jpeg(7, 8), 'info.txt': new TextEncoder().encode('hi'), '.thumb.png': png(1, 1) },
      __MACOSX: { 'Series v02': { '._1.jpg': png(1, 1), 'x.png': png(1, 1) } },
      '../evil.jpg': jpeg(1, 1),
      '/abs.png': png(1, 1),
    }));
    const vol = await importArchive(path, { managedDir });
    expect(vol).toMatchObject({
      kind: 'images',
      title: 'Series v02',
      seriesTitle: 'Series',
      volumeNumber: 2,
      sourcePath: path,
      rootDir: managedDir,
      managedDir,
      hasOcr: false,
      warnings: [],
    });
    expect(vol.pages.map((p) => p.relativePath)).toEqual(['Series v02/1.jpg', 'Series v02/2.png', 'Series v02/10.png']);
    expect(vol.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(vol.pages[0]).toMatchObject({ width: 7, height: 8, blocks: [] });
    expect(existsSync(join(managedDir, 'Series v02', '10.png'))).toBe(true);
    expect(existsSync(join(managedDir, '__MACOSX'))).toBe(false);
    expect(existsSync(join(managedDir, '..', 'evil.jpg'))).toBe(false);
    expect(existsSync(join(managedDir, 'evil.jpg'))).toBe(false);
  });

  it('gives zero sizes for unrecognised image data', async () => {
    const path = await put('in/x.zip', zipSync({ 'a.webp': new Uint8Array([1, 2, 3]) }));
    const vol = await importArchive(path, { managedDir });
    expect(vol.pages).toEqual([{ index: 0, relativePath: 'a.webp', width: 0, height: 0, blocks: [] }]);
  });

  it('rejects an archive without images', async () => {
    const path = await put('in/empty.cbz', zipSync({ 'readme.txt': new TextEncoder().encode('x'), '../evil.png': png(1, 1) }));
    await expect(importArchive(path, { managedDir })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a corrupt archive with a parse error', async () => {
    const path = await put('in/corrupt.cbz', 'PK\u0003\u0004 definitely not a zip');
    await expect(importArchive(path, { managedDir })).rejects.toMatchObject({ code: 'parse' });
  });
});

describe('importImageDir', () => {
  it('collects images one level deep in natural order and sniffs sizes', async () => {
    const dir = join(root, 'Manga Vol. 7');
    await put('Manga Vol. 7/p10.png', png(10, 11));
    await put('Manga Vol. 7/p2.jpg', jpeg(20, 21));
    await put('Manga Vol. 7/chapter 1/a.png', png(1, 1));
    await put('Manga Vol. 7/chapter 1/deep/b.png', png(1, 1));
    await put('Manga Vol. 7/chapter 1/.hidden.png', png(1, 1));
    await put('Manga Vol. 7/.DS_Store.png', png(1, 1));
    await put('Manga Vol. 7/notes.txt', 'x');
    const vol = await importImageDir(dir, { managedDir });
    expect(vol).toMatchObject({ kind: 'images', title: 'Manga Vol. 7', seriesTitle: 'Manga', volumeNumber: 7, sourcePath: dir, rootDir: dir, hasOcr: false, warnings: [] });
    expect(vol).not.toHaveProperty('managedDir');
    expect(vol.pages.map((p) => p.relativePath)).toEqual(['chapter 1/a.png', 'p2.jpg', 'p10.png']);
    expect(vol.pages[1]).toMatchObject({ index: 1, width: 20, height: 21 });
    expect(vol.pages[2]).toMatchObject({ index: 2, width: 10, height: 11 });
  });

  it('rejects a folder without images', async () => {
    const dir = join(root, 'nothing');
    await put('nothing/readme.md', 'x');
    await expect(importImageDir(dir, { managedDir })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('importManga dispatch', () => {
  it('routes .mokuro, archives (any case) and folders', async () => {
    const mokuro = await put('d/A.mokuro', mokuroJson(['a.png', 'b.png']));
    await put('d/a.png', png(1, 1));
    await put('d/b.png', png(1, 1));
    expect((await importManga(mokuro, { managedDir })).kind).toBe('mokuro');

    const cbz = await put('z/B.CBZ', zipSync({ '1.png': png(1, 1) }));
    expect(await importManga(cbz, { managedDir })).toMatchObject({ kind: 'images', managedDir });

    const imgDir = join(root, 'imgs');
    await put('imgs/1.png', png(1, 1));
    expect(await importManga(imgDir, { managedDir })).toMatchObject({ kind: 'images', rootDir: imgDir });
  });

  it('prefers a lone .mokuro inside a folder', async () => {
    await put('f/Vol.mokuro', mokuroJson(['a.png', 'b.png']));
    await put('f/a.png', png(1, 1));
    await put('f/b.png', png(1, 1));
    const vol = await importManga(join(root, 'f'), { managedDir });
    expect(vol).toMatchObject({ kind: 'mokuro', sourcePath: join(root, 'f', 'Vol.mokuro') });
  });

  it('treats a folder with several .mokuro files as an image folder', async () => {
    await put('g/One.mokuro', mokuroJson(['a.png', 'b.png']));
    await put('g/Two.mokuro', mokuroJson(['a.png', 'b.png']));
    await put('g/a.png', png(1, 1));
    const vol = await importManga(join(root, 'g'), { managedDir });
    expect(vol.kind).toBe('images');
    expect(vol.pages.map((p) => p.relativePath)).toEqual(['a.png']);
  });

  it('reports missing paths and unsupported files', async () => {
    await expect(importManga(join(root, 'missing.cbz'), { managedDir })).rejects.toMatchObject({ code: 'not-found' });
    const pdf = await put('x/book.pdf', 'x');
    await expect(importManga(pdf, { managedDir })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
