/**
 * @kotori/core/manga — .mokuro / CBZ / layout engine.
 *
 * Owner: coder-1. Planned modules (see ARCHITECTURE.md §4.3):
 *   - mokuro.ts       parseMokuro(json) → MokuroDocument (pages: relativePath,width,height,blocks)
 *                     parseMangaJson(json) (Fushi `manga.json` compat), serialiseMangaJson()
 *                     normaliseMangaUrl(), resolveMokuroPageRoot(doc, volumeName, exists)
 *   - cbz.ts          listArchiveImages(bytes) → sorted entries; readArchiveEntry() (fflate)
 *   - regions.ts      deriveCharRegions(block) from lines/linesCoords (hit cells)
 *   - hit-test.ts     blockAt(page, x, y), charIndexAt(block, x, y)
 *   - layout.ts       buildSpreads(pages, volume, mode) → MangaSpread[]; pageIndexForSpread()
 *   - volume-name.ts  parseVolumeName(fileName) → { seriesTitle, volumeNumber }
 */
export {};
