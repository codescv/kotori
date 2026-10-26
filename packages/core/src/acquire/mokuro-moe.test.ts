import { describe, expect, it } from 'vitest';
import { parseMokuroMoeListing, resolveMokuroCatalogUrl } from './mokuro-moe';

// `types: []` keeps node typings out of core; load fixtures via an untyped dynamic import.
const NODE_FS = 'node:fs';
async function fixture(name: string): Promise<string> {
  const fs = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync(p: URL, enc: 'utf8'): string };
  return fs.readFileSync(new URL(`../../test-fixtures/acquire/${name}`, import.meta.url), 'utf8');
}

const BASE = 'https://mokuro.moe/manga/Yotsubato!/';
const enc = (s: string) => encodeURIComponent(s).replace(/!/g, '%21');

describe('parseMokuroMoeListing', () => {
  for (const server of ['nginx', 'caddy'] as const) {
    it(`parses the ${server} autoindex fixture`, async () => {
      const listing = parseMokuroMoeListing(await fixture(`mokuro-${server}.html`), BASE);
      expect(listing.url).toBe(BASE);
      expect(listing.path).toEqual(['manga', 'Yotsubato!']);
      expect(listing.entries.map((e) => e.name)).toEqual([
        'よつばと！ 01',
        'cover.jpg',
        'よつばと！ 01.mokuro',
        'よつばと！ 02.cbz',
        'よつばと！ 02.mokuro',
        'よつばと！ 03.mokuro',
        'よつばと！ 03.zip',
        'よつばと！ 04 (Special Edition) & Extras.mokuro',
      ]);
      const dir = listing.entries[0];
      expect(dir).toMatchObject({ kind: 'dir', isMokuro: false, isImageArchive: false, modifiedAt: Date.UTC(2024, 2, 14, 10, 21) });
      expect(dir?.url).toBe(`${BASE.replace('!', '%21')}${enc('よつばと！ 01')}/`.replace('Yotsubato%21', 'Yotsubato!'));
      expect(dir?.url.endsWith('/')).toBe(true);
      expect(dir && 'sizeBytes' in dir).toBe(false);

      const cbz = listing.entries.find((e) => e.name === 'よつばと！ 02.cbz');
      expect(cbz).toMatchObject({ kind: 'file', sizeBytes: 52428800, isImageArchive: true, isMokuro: false });
      expect(cbz?.sizeText).toMatch(/^50(\.0)? MiB$/);
      const mokuro = listing.entries.find((e) => e.name === 'よつばと！ 01.mokuro');
      expect(mokuro).toMatchObject({ isMokuro: true, sizeBytes: 812345, modifiedAt: Date.UTC(2024, 2, 14, 10, 21) });

      expect(listing.volumes).toEqual([
        {
          name: 'よつばと！ 01',
          mokuroUrl: mokuro?.url,
          imagesUrl: dir?.url,
          imagesKind: 'dir',
        },
        {
          name: 'よつばと！ 02',
          mokuroUrl: listing.entries.find((e) => e.name === 'よつばと！ 02.mokuro')?.url,
          imagesUrl: cbz?.url,
          imagesKind: 'archive',
          sizeBytes: 52428800 + 790001,
        },
        {
          name: 'よつばと！ 03',
          mokuroUrl: listing.entries.find((e) => e.name === 'よつばと！ 03.mokuro')?.url,
          imagesUrl: listing.entries.find((e) => e.name === 'よつばと！ 03.zip')?.url,
          imagesKind: 'archive',
          sizeBytes: 49283072 + 801234,
        },
      ]);
    });
  }

  it('uses the href for nginx-truncated names, adds a trailing slash, ignores foreign links', () => {
    const html = `<pre><a href="../">../</a>
<a href="/other/">elsewhere</a>
<a href="https://evil.example/x.zip">x</a>
<a href="?C=M;O=A">sort</a>
<a href="a%20very%20long%20volume%20name%20that%20gets%20cut.mokuro">a very long volume name that ..&gt;</a> 01-Jan-2024 00:00   10K
<a href="a%20very%20long%20volume%20name%20that%20gets%20cut/">a very long volume name that ..&gt;</a> 01-Jan-2024 00:00   -
<a href="Nested/deeper.zip">nested</a>
</pre>`;
    const listing = parseMokuroMoeListing(html, 'https://mokuro.moe/manga');
    expect(listing.url).toBe('https://mokuro.moe/manga/');
    expect(listing.entries.map((e) => [e.kind, e.name])).toEqual([
      ['dir', 'a very long volume name that gets cut'],
      ['file', 'a very long volume name that gets cut.mokuro'],
    ]);
    expect(listing.entries[1]).toMatchObject({ sizeBytes: 10240, sizeText: '10K' });
    expect(listing.volumes).toEqual([
      {
        name: 'a very long volume name that gets cut',
        mokuroUrl: 'https://mokuro.moe/manga/a%20very%20long%20volume%20name%20that%20gets%20cut.mokuro',
        imagesUrl: 'https://mokuro.moe/manga/a%20very%20long%20volume%20name%20that%20gets%20cut/',
        imagesKind: 'dir',
      },
    ]);
  });

  it('pairs NFD names with NFC names and tolerates empty pages', () => {
    const nfd = 'ガ'.normalize('NFD');
    const html = `<a href="${encodeURIComponent(nfd)}.mokuro">m</a><a href="${encodeURIComponent('ガ')}.CBZ">z</a>`;
    const listing = parseMokuroMoeListing(html, 'https://mokuro.moe/');
    expect(listing.path).toEqual([]);
    expect(listing.volumes).toHaveLength(1);
    expect(listing.volumes[0]?.imagesKind).toBe('archive');
    expect(parseMokuroMoeListing('', 'https://mokuro.moe/x/')).toEqual({ url: 'https://mokuro.moe/x/', path: ['x'], entries: [], volumes: [] });
  });

  it('parses Mokuro Bunko JSON /catalog/api/library and /catalog/api/series responses', () => {
    expect(resolveMokuroCatalogUrl('https://mokuro.moe/manga/')).toBe('https://mokuro.moe/catalog/api/library');
    expect(resolveMokuroCatalogUrl('https://mokuro.moe')).toBe('https://mokuro.moe/catalog/api/library');
    expect(resolveMokuroCatalogUrl('https://example.com/manga/')).toBe('https://example.com/manga/');

    const libJson = JSON.stringify({
      series: [
        {
          name: '14 Sai no Koi',
          volume_count: 12,
          latest_volume_modified: 1700000000,
          titles: { native: '14歳の恋', romaji: '14-sai no Koi', english: 'Love at Fourteen' },
        },
      ],
    });
    const lib = parseMokuroMoeListing(libJson, 'https://mokuro.moe/catalog/api/library');
    expect(lib.path).toEqual([]);
    expect(lib.entries).toEqual([
      {
        kind: 'dir',
        name: '14 Sai no Koi',
        url: 'https://mokuro.moe/catalog/api/series?name=14%20Sai%20no%20Koi',
        sizeText: '14歳の恋 · Love at Fourteen · 12 vol',
        modifiedAt: 1700000000000,
        isMokuro: false,
        isImageArchive: false,
      },
    ]);

    const seriesJson = JSON.stringify({
      name: '#Zombie Sagashitemasu',
      volumes: [
        { name: '-Zombie-Sagashitemasu-01', ocr_pending: false },
        { name: '-Zombie-Sagashitemasu-02', ocr_pending: true },
      ],
    });
    const series = parseMokuroMoeListing(seriesJson, 'https://mokuro.moe/catalog/api/series?name=%23Zombie%20Sagashitemasu');
    expect(series.path).toEqual(['#Zombie Sagashitemasu']);
    expect(series.volumes).toEqual([
      {
        name: '-Zombie-Sagashitemasu-01',
        mokuroUrl: 'https://mokuro.moe/mokuro-reader/%23Zombie%20Sagashitemasu/-Zombie-Sagashitemasu-01.mokuro',
        imagesUrl: 'https://mokuro.moe/mokuro-reader/%23Zombie%20Sagashitemasu/-Zombie-Sagashitemasu-01.cbz',
        imagesKind: 'archive',
      },
    ]);
  });
});
