/**
 * @kotori/core/acquire — resource discovery parsers & API clients (fetch-based,
 * injected `fetch` so hosts can proxy / add CORS workarounds).
 *
 * Owner: coder-1. Planned modules (see ARCHITECTURE.md §4.4):
 *   - nyaa.ts        buildNyaaRssUrl(query, base), parseNyaaRss(xml) → NyaaTorrentItem[],
 *                    nyaaMagnet(infoHash, title), parseNyaaSize(text)
 *   - jimaku.ts      createJimakuClient({ fetch, apiKey }): searchEntries, listFiles;
 *                    matchJimakuFilesToEpisodes(files, episodes)
 *   - mokuro-moe.ts  parseMokuroMoeListing(html, url) → MokuroCatalogListing (pairs .mokuro + images)
 *   - magnet.ts      parseMagnet(uri), buildMagnet({ infoHash, name, trackers })
 */
export {};
