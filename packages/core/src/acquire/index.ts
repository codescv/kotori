/**
 * @kotori/core/acquire — resource discovery parsers & API clients (fetch-based,
 * injected `fetch` so hosts can proxy / add CORS workarounds).
 *
 * Owner: coder-1. Modules (see ARCHITECTURE.md §4.4):
 *   - nyaa.ts        buildNyaaRssUrl(query, base), parseNyaaRss(xml) → NyaaTorrentItem[],
 *                    buildNyaaMagnet(infoHash, title), parseNyaaSize(text)
 *   - jimaku.ts      createJimakuClient({ fetch, apiKey, baseUrl }): searchEntries, listFiles;
 *                    mapJimakuEntry, mapJimakuFile, matchJimakuFilesToEpisodes(files, episodes)
 *   - mokuro-moe.ts  parseMokuroMoeListing(html, url) → MokuroCatalogListing (pairs .mokuro + images)
 *   - magnet.ts      parseMagnet(uri), buildMagnet({ infoHash, name, trackers }), normaliseInfoHash
 */
export * from './magnet';
export * from './nyaa';
export * from './jimaku';
export * from './mokuro-moe';
