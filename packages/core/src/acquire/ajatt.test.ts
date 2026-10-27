import { describe, expect, it } from 'vitest';
import {
  ajattEntryId,
  createAjattClient,
  createSubtitleSearchClient,
  isAjattEntryId,
  normalizeSubtitleSearchText,
  parseAjattCatalogHtml,
  parseAjattEntryInfoJson,
  parseAjattEntryPageHtml,
  rankAjattEntries,
} from './ajatt';

const SAMPLE_CATALOG_HTML = `
<table>
  <tbody>
    <tr data-timestamp="1690000000" data-entry-type="anime_tv">
      <td class="entry_name"><a href="anime_tv/Bocchi_the_Rock!.html">Bocchi the Rock!</a></td>
      <td class="english_name">Bocchi the Rock!</td>
      <td class="japanese_name">ぼっち・ざ・ろっく！</td>
    </tr>
    <tr data-timestamp="1700000000" data-entry-type="anime_tv">
      <td class="entry_name"><a href="anime_tv/Sousou_no_Frieren.html">Sousou no Frieren</a></td>
      <td class="english_name">Frieren: Beyond Journey&#39;s End</td>
      <td class="japanese_name">葬送のフリーレン</td>
    </tr>
    <tr data-timestamp="1600000000" data-entry-type="unsorted">
      <td class="entry_name missing_meta"><a href="unsorted/K-ON!.html">K-ON!</a></td>
    </tr>
  </tbody>
</table>
`;

const SAMPLE_ENTRY_HTML = `
<table id="file_list_table">
  <tbody>
    <tr data-timestamp="1690100000" data-file-size="42100">
      <td><a data-download-url="https://raw.githubusercontent.com/Ajatt-Tools/kitsunekko-mirror/refs/heads/main/subtitles/anime_tv/Bocchi%20the%20Rock!/Bocchi%20the%20Rock!%20-%2001.ass" data-filename="Bocchi the Rock! - 01.ass">01.ass</a></td>
    </tr>
    <tr data-timestamp="1690100000" data-file-size="42100">
      <td><a data-download-url="https://raw.githubusercontent.com/Ajatt-Tools/kitsunekko-mirror/refs/heads/main/subtitles/anime_tv/Bocchi%20the%20Rock!/Bocchi%20the%20Rock!%20-%2001.ass" data-filename="Bocchi the Rock! - 01.ass">duplicate row in all tab</a></td>
    </tr>
    <tr data-timestamp="1690200000" data-file-size="38500">
      <td><a data-download-url="https://raw.githubusercontent.com/Ajatt-Tools/kitsunekko-mirror/refs/heads/main/subtitles/anime_tv/Bocchi%20the%20Rock!/Bocchi%20the%20Rock!%20-%2002.srt" data-filename="Bocchi the Rock! - 02.srt">02.srt</a></td>
    </tr>
  </tbody>
</table>
`;

describe('AJATT subtitle catalog & client', () => {
  it('computes deterministic negative IDs for AJATT entries', () => {
    const id = ajattEntryId('anime_tv/Bocchi_the_Rock!.html');
    expect(id).toBeLessThan(0);
    expect(isAjattEntryId(id)).toBe(true);
    expect(isAjattEntryId(3127)).toBe(false);
    expect(ajattEntryId('anime_tv/Bocchi_the_Rock!.html')).toBe(id);
  });

  it('normalizes fullwidth, katakana, and punctuation for title matching', () => {
    expect(normalizeSubtitleSearchText('ぼっち・ざ・ろっく！')).toBe('ぼっちざろっく');
    expect(normalizeSubtitleSearchText('ボッチ・ザ・ロック!')).toBe('ぼっちざろっく');
    expect(normalizeSubtitleSearchText('Bocchi the Rock!')).toBe('bocchitherock');
  });

  it('parses catalog HTML and ranks exact matches ahead of partial matches', () => {
    const catalog = parseAjattCatalogHtml(SAMPLE_CATALOG_HTML);
    expect(catalog).toHaveLength(3);
    expect(catalog[0]).toMatchObject({
      type: 'anime_tv',
      pagePath: 'anime_tv/Bocchi_the_Rock!.html',
      name: 'Bocchi the Rock!',
      japaneseName: 'ぼっち・ざ・ろっく！',
    });
    expect(catalog[1]?.englishName).toBe("Frieren: Beyond Journey's End");

    const ranked = rankAjattEntries(catalog, ['ぼっち・ざ・ろっく！']);
    expect(ranked.map((r) => r.name)).toEqual(['Bocchi the Rock!']);
  });

  it('parses entry page HTML and deduplicates repeated file rows', () => {
    const id = ajattEntryId('anime_tv/Bocchi_the_Rock!.html');
    const files = parseAjattEntryPageHtml(SAMPLE_ENTRY_HTML, id);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      entryId: id,
      name: 'Bocchi the Rock! - 01.ass',
      extension: 'ass',
      isTextSubtitle: true,
      episode: 1,
      sizeBytes: 42100,
    });
    expect(files[1]).toMatchObject({
      entryId: id,
      name: 'Bocchi the Rock! - 02.srt',
      extension: 'srt',
      isTextSubtitle: true,
      episode: 2,
    });
  });

  it('parses .kitsuinfo.json and falls back seamlessly via createSubtitleSearchClient without API key', async () => {
    const info = parseAjattEntryInfoJson(
      JSON.stringify({
        entry_id: 2045,
        name: 'Bocchi the Rock!',
        entry_type: 'anime_tv',
        english_name: 'Bocchi the Rock!',
        japanese_name: 'ぼっち・ざ・ろっく！',
        anilist_id: 130003,
      }),
    );
    expect(info?.anilistId).toBe(130003);

    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/index.html')) return new Response(SAMPLE_CATALOG_HTML, { status: 200 });
      if (url.endsWith('/anime_tv/Bocchi_the_Rock!.html')) return new Response(SAMPLE_ENTRY_HTML, { status: 200 });
      if (url.endsWith('/.kitsuinfo.json')) {
        return new Response(JSON.stringify({ name: 'Bocchi the Rock!', entry_type: 'anime_tv', anilist_id: 130003 }), {
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const client = createSubtitleSearchClient({ fetch: fakeFetch, jimakuApiKey: '' });
    const entries = await client.searchEntries({ query: 'Bocchi the Rock!|ぼっち・ざ・ろっく！', anilistId: 130003 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'Bocchi the Rock!',
      japaneseName: 'ぼっち・ざ・ろっく！',
      anilistId: 130003,
    });
    const files = await client.listFiles(entries[0]!.id);
    expect(files).toHaveLength(2);
    const ep1Only = await client.listFiles(entries[0]!.id, 1);
    expect(ep1Only).toHaveLength(1);
    expect(ep1Only[0]?.episode).toBe(1);

    const directAjatt = createAjattClient({ fetch: fakeFetch });
    expect((await directAjatt.loadCatalog()).length).toBe(3);
  });
});
