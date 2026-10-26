/**
 * @kotori/core/manga — .mokuro / CBZ / layout engine.
 *
 * Owner: coder-1. Modules (see ARCHITECTURE.md §4.3):
 *   - mokuro.ts       parseMokuro(json) → MokuroDocument (pages: relativePath,width,height,blocks)
 *                     parseMangaJson(json) (Fushi `manga.json` compat), serialiseMangaJson()
 *                     normaliseMangaUrl(), resolveMokuroPageRoot(doc, volumeName, exists)
 *   - cbz.ts          listArchiveImages(bytes) → sorted entries; readArchiveEntry(); readImageSize()
 *   - regions.ts      deriveCharRegions(block) from lines/linesCoords (hit cells)
 *   - hit-test.ts     blockAt(page, x, y), charIndexAt(block, x, y)
 *   - layout.ts       buildSpreads(pages, opts) → MangaSpread[]; spreadIndexForPage()
 *   - volume-name.ts  parseVolumeName(fileName) → { seriesTitle, volumeNumber? }
 */
export * from './mokuro';
export * from './cbz';
export * from './regions';
export * from './hit-test';
export * from './layout';
export * from './volume-name';
