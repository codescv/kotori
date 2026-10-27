import { describe, expect, it } from 'vitest';
import {
  buildNyaaMagnet,
  buildNyaaRssUrl,
  buildNyaaSearchUrl,
  mergeNyaaItems,
  NYAA_TRACKERS,
  parseNyaaRss,
  parseNyaaSearchHtml,
  parseNyaaSize,
  sortNyaaItems,
} from './nyaa';
import { decodeXmlEntities } from './xml';
import { parseMagnet } from './magnet';

// `types: []` keeps node typings out of core; load fixtures via an untyped dynamic import.
const NODE_FS = 'node:fs';
async function fixture(name: string): Promise<string> {
  const fs = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync(p: URL, enc: 'utf8'): string };
  return fs.readFileSync(new URL(`../../test-fixtures/acquire/${name}`, import.meta.url), 'utf8');
}

describe('buildNyaaRssUrl', () => {
  it('uses the documented defaults', () => {
    expect(buildNyaaRssUrl({ query: 'sousou no frieren' })).toBe(
      'https://nyaa.si/?page=rss&q=sousou%20no%20frieren&c=1_4&f=0&s=seeders&o=desc',
    );
  });

  it('maps filter / sort / page and trims the base', () => {
    expect(
      buildNyaaRssUrl({ query: '葬送 & 01', category: '1_0', filter: 'trusted-only', sort: 'date', page: 3 }, 'https://nyaa.land/'),
    ).toBe(`https://nyaa.land/?page=rss&q=${encodeURIComponent('葬送 & 01')}&c=1_0&f=2&s=id&o=desc&p=3`);
    expect(buildNyaaRssUrl({ query: 'x', filter: 'no-remakes', sort: 'size', page: 1 })).toContain('&f=1&s=size&o=desc');
  });
});

describe('parseNyaaSize', () => {
  it('parses binary and SI units', () => {
    expect(parseNyaaSize('1.4 GiB')).toBe(Math.round(1.4 * 1024 ** 3));
    expect(parseNyaaSize('742.5 MiB')).toBe(Math.round(742.5 * 1024 ** 2));
    expect(parseNyaaSize('512 KiB')).toBe(524288);
    expect(parseNyaaSize('2 TiB')).toBe(2 * 1024 ** 4);
    expect(parseNyaaSize('12 Bytes')).toBe(12);
    expect(parseNyaaSize('1 GB')).toBe(1e9);
    expect(parseNyaaSize('50M')).toBe(50 * 1024 ** 2);
    expect(parseNyaaSize('812345')).toBe(812345);
    expect(parseNyaaSize('lots')).toBeUndefined();
    expect(parseNyaaSize('3 parsecs')).toBeUndefined();
  });
});

describe('buildNyaaMagnet', () => {
  it('includes the hash, the title and every default tracker', () => {
    const uri = buildNyaaMagnet('6B0A5C1F3E4D2A9B8C7D6E5F4A3B2C1D0E9F8A7B', '[G] Title - 01');
    const parsed = parseMagnet(uri);
    expect(parsed.infoHash).toBe('6b0a5c1f3e4d2a9b8c7d6e5f4a3b2c1d0e9f8a7b');
    expect(parsed.name).toBe('[G] Title - 01');
    expect(parsed.trackers).toEqual([...NYAA_TRACKERS]);
    expect(NYAA_TRACKERS).toContain('http://nyaa.tracker.wf:7777/announce');
  });
});

describe('decodeXmlEntities', () => {
  it('decodes named and numeric references, keeps unknown ones', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27; &#x1F600; &bogus;')).toBe(`a & b <c> "d" 'e' 😀 &bogus;`);
  });
});

describe('parseNyaaRss', () => {
  it('parses the real-world fixture', async () => {
    const items = parseNyaaRss(await fixture('nyaa-rss.xml'));
    expect(items).toHaveLength(3);
    const [first, batch, jp] = items;
    expect(first).toMatchObject({
      title: '[Ohys-Raws] Sousou no Frieren - 01 (NTV 1280x720 x264 AAC).mp4',
      torrentUrl: 'https://nyaa.si/download/1729401.torrent',
      pageUrl: 'https://nyaa.si/view/1729401',
      infoHash: '6b0a5c1f3e4d2a9b8c7d6e5f4a3b2c1d0e9f8a7b',
      seeders: 412,
      leechers: 3,
      downloads: 18234,
      sizeText: '1.4 GiB',
      sizeBytes: Math.round(1.4 * 1024 ** 3),
      categoryId: '1_4',
      trusted: true,
      remake: false,
      publishedAt: Date.UTC(2023, 8, 29, 15, 33, 2),
    });
    expect(first?.magnet.startsWith('magnet:?xt=urn:btih:6b0a5c1f3e4d2a9b8c7d6e5f4a3b2c1d0e9f8a7b&dn=')).toBe(true);
    expect(first?.parsedName).toMatchObject({ title: 'Sousou no Frieren', episode: 1, releaseGroup: 'Ohys-Raws', resolution: '720p' });

    expect(batch?.title).toBe('[Moozzi2] Sousou no Frieren [ 01-28 ] (BD 1920x1080 x265-10Bit Flac) & SP');
    expect(batch?.parsedName).toMatchObject({ isBatch: true, episodeRange: [1, 28], source: 'BD', resolution: '1080p' });
    expect(batch?.trusted).toBe(false);

    expect(jp?.title).toBe('葬送のフリーレン 第05話「死者の幻影」 (BS11 1920x1080 HEVC "10bit").mkv');
    expect(jp?.remake).toBe(true);
    expect(jp?.parsedName).toMatchObject({ title: '葬送のフリーレン', episode: 5, videoCodec: 'HEVC' });
  });

  it('decodes CDATA, tolerates missing fields and magnet links', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[A & B <raw> - 02]]></title>
        <link>magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&amp;dn=x</link>
        <guid isPermaLink="true">https://nyaa.si/view/42</guid>
        <nyaa:size>oops</nyaa:size></item>
      <item><title></title></item>
      <ITEM><TITLE>Upper &amp; case</TITLE><nyaa:seeders>7</nyaa:seeders></ITEM>
    </channel></rss>`;
    const items = parseNyaaRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'A & B <raw> - 02',
      infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
      torrentUrl: 'https://nyaa.si/download/42.torrent',
      seeders: 0,
      sizeText: 'oops',
      publishedAt: 0,
      trusted: false,
    });
    expect(items[0] && 'sizeBytes' in items[0]).toBe(false);
    expect(items[1]).toMatchObject({ title: 'Upper & case', seeders: 7, infoHash: '', magnet: '' });
  });

  it('returns [] for garbage', () => {
    expect(parseNyaaRss('not xml at all')).toEqual([]);
    expect(parseNyaaRss('')).toEqual([]);
  });
});

describe('sortNyaaItems', () => {
  it('sorts items by seeders, date, size and downloads', async () => {
    const items = parseNyaaRss(await fixture('nyaa-rss.xml'));
    expect(sortNyaaItems(items, 'seeders').map((x) => x.seeders)).toEqual([412, 87, 5]);
    expect(sortNyaaItems(items, 'size').map((x) => x.sizeText)).toEqual(['86.2 GiB', '1.4 GiB', '742.5 MiB']);
    expect(sortNyaaItems(items, 'downloads').map((x) => x.downloads)).toEqual([18234, 2210, 731]);
    const byDate = sortNyaaItems(items, 'date');
    expect(byDate[0]?.publishedAt).toBeGreaterThanOrEqual(byDate[1]?.publishedAt ?? 0);
    expect(byDate[1]?.publishedAt).toBeGreaterThanOrEqual(byDate[2]?.publishedAt ?? 0);
  });
});

describe('buildNyaaSearchUrl & parseNyaaSearchHtml', () => {
  it('builds HTML search URL defaulting to category 1_0 (All Anime)', () => {
    expect(buildNyaaSearchUrl({ query: 'bocchi' })).toBe(
      'https://nyaa.si/?q=bocchi&c=1_0&f=0&s=seeders&o=desc',
    );
    expect(buildNyaaSearchUrl({ query: 'Bocchi the Rock!', category: '1_2', filter: 'trusted-only', sort: 'downloads', page: 2 })).toBe(
      'https://nyaa.si/?q=Bocchi%20the%20Rock!&c=1_2&f=2&s=downloads&o=desc&p=2',
    );
  });

  it('parses Nyaa HTML table rows including [Judas] Bocchi the Rock! batch and comment links', () => {
    const html = `
      <table class="table table-bordered table-hover table-striped torrent-list">
        <tbody>
          <tr class="danger">
            <td>
              <a href="/?c=1_2" title="Anime - English-translated"></a>
            </td>
            <td colspan="2">
              <a href="/view/1861251#comments" class="comments" title="1 comment"><i class="fa fa-comments-o"></i>1</a>
              <a href="/view/1861251" title="[Judas] Bocchi the Rock! (Season 1) [BD 1080p][HEVC x265 10bit][Multi-Subs] (Batch)">[Judas] Bocchi the Rock! (Season 1) [BD 1080p][HEVC x265 10bit][Multi-Subs] (Batch)</a>
            </td>
            <td class="text-center">
              <a href="/download/1861251.torrent"><i class="fa fa-fw fa-download"></i></a>
              <a href="magnet:?xt=urn:btih:99f948a9ea653f2f3679ce0a42792013628f894e&amp;dn=%5BJudas%5D"><i class="fa fa-fw fa-magnet"></i></a>
            </td>
            <td class="text-center">2.6 GiB</td>
            <td class="text-center" data-timestamp="1723923229">2024-08-17 19:33</td>
            <td class="text-center">180</td>
            <td class="text-center">5</td>
            <td class="text-center">15701</td>
          </tr>
          <tr class="success">
            <td><a href="/?c=1_2" title="Anime - English-translated"></a></td>
            <td colspan="2">
              <a href="/view/1626385" title="[SubsPlease] Bocchi the Rock! (01-12) (1080p) [Batch]">[SubsPlease] Bocchi the Rock! (01-12) (1080p) [Batch]</a>
            </td>
            <td class="text-center">
              <a href="/download/1626385.torrent"></a>
              <a href="magnet:?xt=urn:btih:9f4961a9c71eeb53abce2ef2afc587b452dee5eb&amp;dn=x"></a>
            </td>
            <td class="text-center">16.1 GiB</td>
            <td class="text-center" data-timestamp="1674035960">2023-01-18 09:59</td>
            <td class="text-center">149</td>
            <td class="text-center">2</td>
            <td class="text-center">26729</td>
          </tr>
        </tbody>
      </table>
    `;
    const items = parseNyaaSearchHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: '[Judas] Bocchi the Rock! (Season 1) [BD 1080p][HEVC x265 10bit][Multi-Subs] (Batch)',
      pageUrl: 'https://nyaa.si/view/1861251',
      torrentUrl: 'https://nyaa.si/download/1861251.torrent',
      infoHash: '99f948a9ea653f2f3679ce0a42792013628f894e',
      categoryId: '1_2',
      sizeText: '2.6 GiB',
      publishedAt: 1723923229000,
      seeders: 180,
      leechers: 5,
      downloads: 15701,
      trusted: false,
      remake: true,
    });
    expect(items[1]).toMatchObject({
      title: '[SubsPlease] Bocchi the Rock! (01-12) (1080p) [Batch]',
      infoHash: '9f4961a9c71eeb53abce2ef2afc587b452dee5eb',
      seeders: 149,
      trusted: true,
      remake: false,
    });

    const merged = mergeNyaaItems([items, [items[0]!]], 'downloads');
    expect(merged).toHaveLength(2);
    expect(merged[0]?.title).toContain('[SubsPlease]');
  });
});
