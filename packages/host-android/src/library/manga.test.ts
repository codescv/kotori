import { afterEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import type { HostEvent } from '@kotori/core';
import { createTestHost, pngHeader, type TestHost } from '../testing/harness';
import { loadFixtureDir } from '../testing/fixtures';

const open: TestHost[] = [];
async function makeHost(): Promise<TestHost> {
  const t = await createTestHost();
  open.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.host.dispose()));
});

const LIB = 'file:///storage/emulated/0/Manga';
const src = (p: string): string => `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`;

describe('manga library', () => {
  it('imports a .mokuro whose images live in a same-named sub-folder', async () => {
    const t = await makeHost();
    await loadFixtureDir(t.fs, 'mokuro-subfolder', LIB);
    const events: HostEvent[] = [];
    t.host.subscribe((e) => events.push(e));
    const path = `${LIB}/Test Manga 第2巻.mokuro`;
    const volume = await t.host.manga.importVolume({ path });
    expect(volume).toMatchObject({
      title: 'Test Manga 第2巻',
      seriesTitle: 'Test Manga',
      volumeNumber: 2,
      kind: 'mokuro',
      sourcePath: path,
      pageCount: 3,
      hasOcr: true,
      coverIsSingle: true,
    });
    expect(volume.coverUrl).toBe(src(`${LIB}/Test Manga 第2巻/001.png`));
    expect(events).toContainEqual({ type: 'library-changed', scope: 'manga' });

    const pages = await t.host.manga.getPages(volume.id);
    expect(pages.map((p) => p.relativePath)).toEqual(['001.png', '002.png', '003.png']);
    expect(pages[0]).toMatchObject({ width: 800, height: 1200 });
    expect(pages[0]?.imageUrl).toBe(src(`${LIB}/Test Manga 第2巻/001.png`));
    const first = await t.host.manga.getPage(volume.id, 0);
    expect(first.blocks).toHaveLength(2);
    expect(first.blocks[0]).toMatchObject({ index: 0, vertical: true, text: '食べてんじゃねぇよ', lines: ['食べてんじゃ', 'ねぇよ'], source: 'mokuro' });
    expect(first.blocks[0]?.rect).toEqual({ left: 600, top: 100, right: 700, bottom: 500 });
    expect((await t.host.manga.getPage(volume.id, 2)).width).toBe(1600);
    await expect(t.host.manga.getPage(volume.id, 9)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('imports a .mokuro with images beside it and sniffs missing page sizes', async () => {
    const t = await makeHost();
    await loadFixtureDir(t.fs, 'mokuro-beside', `${LIB}/beside`);
    const volume = await t.host.manga.importVolume({ path: `${LIB}/beside/Beside v01.mokuro` });
    expect(volume).toMatchObject({ title: 'Beside v01', pageCount: 2, kind: 'mokuro' });
    const pages = await t.host.manga.getPages(volume.id);
    expect(pages[0]?.imageUrl).toBe(src(`${LIB}/beside/p1.png`));
    expect(pages[1]).toMatchObject({ width: 10, height: 14 });
  });

  it('rejects a .mokuro whose page images are missing', async () => {
    const t = await makeHost();
    await t.fs.writeFile(`${LIB}/lonely.mokuro`, new TextEncoder().encode(JSON.stringify({ pages: [{ img_path: 'x.png', blocks: [] }] })));
    await expect(t.host.manga.importVolume({ path: `${LIB}/lonely.mokuro` })).rejects.toMatchObject({ code: 'not-found' });
    await t.fs.writeFile(`${LIB}/broken.mokuro`, new TextEncoder().encode('{not json'));
    await expect(t.host.manga.importVolume({ path: `${LIB}/broken.mokuro` })).rejects.toMatchObject({ code: 'parse' });
  });

  it('extracts a CBZ into manga/{volumeId}/ exactly once', async () => {
    const t = await makeHost();
    const zip = zipSync({
      'Vol 3/p10.png': pngHeader(900, 1300),
      'Vol 3/p2.png': pngHeader(800, 1200),
      'Vol 3/p1.png': pngHeader(800, 1200),
      'Vol 3/spread/p11.png': pngHeader(1600, 1200),
      '__MACOSX/Vol 3/._p1.png': new Uint8Array([0]),
      'Vol 3/info.txt': new TextEncoder().encode('hi'),
    });
    const cbz = `${LIB}/Some Series v03.cbz`;
    await t.fs.writeFile(cbz, zip);
    const volume = await t.host.manga.importVolume({ path: cbz });
    expect(volume).toMatchObject({ kind: 'images', hasOcr: false, pageCount: 4, seriesTitle: 'Some Series', volumeNumber: 3 });
    const pages = await t.host.manga.getPages(volume.id);
    expect(pages.map((p) => p.relativePath)).toEqual(['Vol 3/p1.png', 'Vol 3/p2.png', 'Vol 3/p10.png', 'Vol 3/spread/p11.png']);
    expect(pages.map((p) => [p.width, p.height])).toEqual([
      [800, 1200],
      [800, 1200],
      [900, 1300],
      [1600, 1200],
    ]);
    const outDir = `${t.deps.dataRoot}/manga/${volume.id}`;
    expect(pages[0]?.imageUrl).toBe(src(`${outDir}/Vol 3/p1.png`));
    expect(await t.fs.stat(`${outDir}/Vol 3/p10.png`)).toBeDefined();
    expect(await t.fs.stat(`${outDir}/__MACOSX`)).toBeUndefined();

    const writesBefore = t.fs.writes(outDir);
    const again = await t.host.manga.importVolume({ path: cbz, titleOverride: 'Renamed' });
    expect(again.id).toBe(volume.id);
    expect(again.title).toBe('Renamed');
    expect(t.fs.writes(outDir)).toBe(writesBefore);

    await t.host.manga.removeVolume(volume.id);
    expect(await t.fs.stat(outDir)).toBeUndefined();
    expect(await t.fs.stat(cbz)).toBeDefined();
    expect(await t.host.manga.listVolumes()).toEqual([]);
  });

  it('imports an image directory and persists reading mode, cover, progress and VLM blocks', async () => {
    const t = await makeHost();
    const dir = `${LIB}/raw/第1巻`;
    for (const name of ['10.png', '2.png', '1.png']) await t.fs.writeFile(`${dir}/${name}`, pngHeader(700, 1000));
    const volume = await t.host.manga.importVolume({ path: dir });
    expect(volume).toMatchObject({ kind: 'images', pageCount: 3, volumeNumber: 1 });
    expect((await t.host.manga.getPages(volume.id)).map((p) => p.relativePath)).toEqual(['1.png', '2.png', '10.png']);

    expect((await t.host.manga.setReadingMode(volume.id, 'webtoon')).readingMode).toBe('webtoon');
    expect((await t.host.manga.setReadingMode(volume.id, undefined)).readingMode).toBeUndefined();
    expect((await t.host.manga.setCoverIsSingle(volume.id, false)).coverIsSingle).toBe(false);
    await t.host.manga.saveProgress(volume.id, { pageIndex: 2, updatedAt: 99 });
    expect((await t.host.manga.getVolume(volume.id)).progress).toEqual({ pageIndex: 2, updatedAt: 99 });

    const page = await t.host.manga.addBlocks(volume.id, 1, [
      { rect: { left: 1, top: 2, right: 30, bottom: 40 }, vertical: true, fontSize: 20, zIndex: 0, lines: ['えっ'], text: 'えっ', source: 'vlm' },
    ]);
    expect(page.blocks).toEqual([expect.objectContaining({ index: 0, text: 'えっ', source: 'vlm' })]);
    expect((await t.host.manga.getVolume(volume.id)).hasOcr).toBe(true);
    // Re-import keeps VLM blocks.
    await t.host.manga.importVolume({ path: dir });
    expect((await t.host.manga.getPage(volume.id, 1)).blocks).toHaveLength(1);
  });

  it('rejects unsupported sources', async () => {
    const t = await makeHost();
    await t.fs.writeFile(`${LIB}/x.pdf`, new Uint8Array([1]));
    await expect(t.host.manga.importVolume({ path: `${LIB}/x.pdf` })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(t.host.manga.importVolume({ path: `${LIB}/nope` })).rejects.toMatchObject({ code: 'not-found' });
  });
});
