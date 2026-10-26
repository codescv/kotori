import { describe, expect, it } from 'vitest';
import {
  joinMokuroPageRoot,
  mokuroPageRootCandidates,
  normaliseMangaUrl,
  parseMangaJson,
  parseMokuro,
  resolveMokuroPageRoot,
  serialiseMangaJson,
  type MokuroDocument,
} from './mokuro';

// `@types/node` is deliberately not in core's tsconfig (platform-neutral), so
// load node:fs through an untyped dynamic import — tests run under Node only.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync(path: URL, encoding: 'utf8'): string;
};
const fixture = (name: string): string => readFileSync(new URL(`../../test-fixtures/manga/${name}`, import.meta.url), 'utf8');

function mustParse(json: string): { doc: MokuroDocument; warnings: readonly string[] } {
  const r = parseMokuro(json);
  if (!r.ok) throw new Error(r.error);
  return { doc: r.value, warnings: r.warnings };
}

describe('parseMokuro', () => {
  it('parses a v0.2 document with volume-prefixed img_path (convention A)', () => {
    const { doc, warnings } = mustParse(fixture('volume-prefixed.mokuro'));
    expect(warnings).toEqual([]);
    expect(doc.title).toBe('よつばと!');
    expect(doc.titleUuid).toBe('6f1d9d0e-6c0b-4a3e-9a51-0c8f7b2b1a11');
    expect(doc.volume).toBe('よつばと! 第01巻');
    expect(doc.volumeUuid).toBe('b3a7c2f4-1e2d-4c5b-8a9f-2d3e4f5a6b7c');
    expect(doc.pages.map((p) => p.relativePath)).toEqual(['よつばと! 第01巻/0001.jpg', 'よつばと! 第01巻/0002.jpg']);
    const page = doc.pages[0]!;
    expect(page).toMatchObject({ index: 0, width: 1654, height: 2339 });
    const block = page.blocks[0]!;
    expect(block).toMatchObject({
      index: 0,
      zIndex: 0,
      vertical: true,
      fontSize: 44,
      rect: { left: 1337, top: 166, right: 1471, bottom: 482 },
      lines: ['とーちゃん！', 'あれなに？'],
      text: 'とーちゃん！あれなに？',
      source: 'mokuro',
    });
    expect(block.linesCoords?.[0]).toEqual([
      [1424, 170],
      [1468, 170],
      [1468, 478],
      [1424, 478],
    ]);
    expect('regions' in block).toBe(false);
    expect('confidence' in block).toBe(false);
    expect(page.blocks[1]!.zIndex).toBe(1);
  });

  it('parses bare img_path names (convention B) and skips malformed entries with warnings', () => {
    const { doc, warnings } = mustParse(fixture('bare-names.mokuro'));
    expect(doc.pages.map((p) => p.relativePath)).toEqual(['DLRAW.TO_00001.jpeg', 'DLRAW.TO_00002.jpeg']);
    const blocks = doc.pages[0]!.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ index: 1, zIndex: 1, rect: { left: 0, top: 0, right: 0, bottom: 0 }, text: 'box missing' });
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/blocks\[1\]: not an object/);
    expect(warnings.join('\n')).toMatch(/missing or malformed "box"/);
    expect(warnings.join('\n')).toMatch(/pages\[2\]: missing "img_path"/);
  });

  it('applies defaults and coerces numeric strings', () => {
    const { doc } = mustParse(
      JSON.stringify({ pages: [{ img_path: 'a.png', img_width: '100', blocks: [{ box: ['1', 2, 3, 4], lines: ['a', 7, null] }] }] }),
    );
    const page = doc.pages[0]!;
    expect(page.width).toBe(100);
    expect(page.height).toBe(0);
    expect(page.blocks[0]).toMatchObject({ vertical: false, fontSize: 0, lines: ['a', '7', ''], text: 'a7', rect: { left: 1 } });
    expect(doc.title).toBeUndefined();
    expect('title' in doc).toBe(false);
  });

  it('fails without throwing on unreadable input', () => {
    expect(parseMokuro('not json').ok).toBe(false);
    expect(parseMokuro('[]').ok).toBe(false);
    expect(parseMokuro('{"title":"x"}')).toMatchObject({ ok: false, error: 'missing "pages" array' });
    expect(parseMokuro('\ufeff{"pages":[]}')).toMatchObject({ ok: true, value: { pages: [] } });
  });
});

describe('parseMangaJson / serialiseMangaJson', () => {
  const mangaJson = JSON.stringify({
    pages: [
      {
        url: 'ch1\\p01.png',
        width: 800,
        height: 1200,
        blocks: [
          {
            box: [10, 20, 110, 220],
            vertical: true,
            font_size: 30,
            z_index: 5,
            lines: ['あい', 'う'],
            lines_coords: [
              [
                [60, 20],
                [110, 20],
                [110, 220],
                [60, 220],
              ],
              [
                [10, 20],
                [60, 20],
                [60, 120],
                [10, 120],
              ],
            ],
            regions: [
              { box: [60, 20, 110, 120], utf16_start: 0, utf16_end: 1 },
              { box: [0, 0, 1, 1], utf16_start: 2, utf16_end: 9 },
            ],
            confidence: 0.75,
          },
          { box: [0, 0, 5, 5], lines: ['x'], source: 'vlm' },
        ],
      },
    ],
  });

  it('reads explicit z_index, regions, confidence and source', () => {
    const r = parseMangaJson(mangaJson);
    if (!r.ok) throw new Error(r.error);
    const page = r.value.pages[0]!;
    expect(page.relativePath).toBe('ch1/p01.png');
    const [a, b] = page.blocks;
    expect(a).toMatchObject({ zIndex: 5, confidence: 0.75, source: 'mokuro', text: 'あいう' });
    // The out-of-range region (end 9 > text length 3) is dropped.
    expect(a!.regions).toEqual([{ rect: { left: 60, top: 20, right: 110, bottom: 120 }, utf16Start: 0, utf16End: 1 }]);
    expect(b).toMatchObject({ zIndex: 1, source: 'vlm' });
  });

  it('round-trips through serialiseMangaJson', () => {
    const first = parseMangaJson(mangaJson);
    if (!first.ok) throw new Error(first.error);
    const json = serialiseMangaJson(first.value);
    const raw = JSON.parse(json) as { pages: { url: string; blocks: Record<string, unknown>[] }[] };
    expect(raw.pages[0]!.url).toBe('ch1/p01.png');
    expect(raw.pages[0]!.blocks[0]).toMatchObject({ box: [10, 20, 110, 220], z_index: 5, font_size: 30, confidence: 0.75 });
    expect('source' in raw.pages[0]!.blocks[0]!).toBe(false);
    expect(raw.pages[0]!.blocks[1]!['source']).toBe('vlm');
    expect('lines_coords' in raw.pages[0]!.blocks[1]!).toBe(false);
    const second = parseMangaJson(json);
    expect(second).toEqual(first);
  });

  it('serialises a parsed .mokuro document into manga.json', () => {
    const { doc } = mustParse(fixture('volume-prefixed.mokuro'));
    const back = parseMangaJson(serialiseMangaJson(doc));
    if (!back.ok) throw new Error(back.error);
    expect(back.value.pages).toEqual(doc.pages);
    expect(back.value.title).toBe(doc.title);
  });

  it('rejects non-object input', () => {
    expect(parseMangaJson('42')).toMatchObject({ ok: false });
  });
});

describe('normaliseMangaUrl', () => {
  it('converts separators and strips leading slashes / dot segments', () => {
    expect(normaliseMangaUrl('vol1\\p001.jpg')).toBe('vol1/p001.jpg');
    expect(normaliseMangaUrl('/vol1/p001.jpg')).toBe('vol1/p001.jpg');
    expect(normaliseMangaUrl('./vol1//sub/p001.jpg')).toBe('vol1/sub/p001.jpg');
    expect(normaliseMangaUrl('p.jpg')).toBe('p.jpg');
  });
});

describe('mokuroPageRootCandidates / joinMokuroPageRoot', () => {
  it('lists beside-the-file then same-named subfolder', () => {
    expect(mokuroPageRootCandidates('Vol3')).toEqual([[], ['Vol3']]);
    expect(mokuroPageRootCandidates('  ')).toEqual([[]]);
  });
  it('joins roots', () => {
    expect(joinMokuroPageRoot([], 'a/b.jpg')).toBe('a/b.jpg');
    expect(joinMokuroPageRoot(['Vol3'], 'b.jpg')).toBe('Vol3/b.jpg');
  });
});

describe('resolveMokuroPageRoot', () => {
  const probe = (files: string[]) => (rel: string) => files.includes(rel);

  it('resolves convention A (img_path carries the volume prefix) to []', () => {
    const { doc } = mustParse(fixture('volume-prefixed.mokuro'));
    const files = ['よつばと! 第01巻/0001.jpg', 'よつばと! 第01巻/0002.jpg'];
    expect(resolveMokuroPageRoot(doc, 'よつばと! 第01巻', probe(files))).toEqual([]);
  });

  it('resolves convention B (bare names in a same-named subfolder) to [volumeName]', () => {
    const { doc } = mustParse(fixture('bare-names.mokuro'));
    const files = ['Vol3/DLRAW.TO_00001.jpeg', 'Vol3/DLRAW.TO_00002.jpeg'];
    expect(resolveMokuroPageRoot(doc, 'Vol3', probe(files))).toEqual(['Vol3']);
  });

  it('prefers a complete candidate and falls back to the first-page hit', () => {
    const { doc } = mustParse(fixture('bare-names.mokuro'));
    // First page beside the file but only the subfolder is complete.
    expect(resolveMokuroPageRoot(doc, 'Vol3', probe(['DLRAW.TO_00001.jpeg', 'Vol3/DLRAW.TO_00001.jpeg', 'Vol3/DLRAW.TO_00002.jpeg']))).toEqual([
      'Vol3',
    ]);
    // Neither complete: return the first candidate that has page 1.
    expect(resolveMokuroPageRoot(doc, 'Vol3', probe(['Vol3/DLRAW.TO_00001.jpeg']))).toEqual(['Vol3']);
  });

  it('returns undefined when the first page is nowhere or there are no pages', () => {
    const { doc } = mustParse(fixture('bare-names.mokuro'));
    expect(resolveMokuroPageRoot(doc, 'Vol3', () => false)).toBeUndefined();
    expect(resolveMokuroPageRoot({ pages: [] }, 'Vol3', () => true)).toBeUndefined();
  });
});
