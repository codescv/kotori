/**
 * `.mokuro` (v0.2) and Kotori/Fushi `manga.json` parsing + serialisation, and
 * page-root resolution for the two `img_path` conventions found in the wild.
 *
 * Mirrors Fushi `packages/fushi_engine/lib/media/manga/mokuro_payload.dart`.
 * Parsers are tolerant: missing fields get defaults, malformed pages/blocks are
 * skipped with a warning, and only an unreadable top level yields `ok: false`.
 */
import type {
  MangaBlock,
  MangaBlockSource,
  MangaCharRegion,
  MangaPage,
  MangaPoint,
  MangaRect,
  ParseResult,
} from '../types';

/** A page as parsed from OCR JSON — everything but the host-specific `imageUrl`. */
export type MokuroPage = Omit<MangaPage, 'imageUrl'>;

/**
 * In-memory shape shared by `.mokuro` import and `manga.json` round-trips.
 * Page `relativePath`s are forward-slash and relative to the resolved page root
 * (see {@link resolveMokuroPageRoot}).
 */
export interface MokuroDocument {
  readonly title?: string;
  readonly titleUuid?: string;
  readonly volume?: string;
  readonly volumeUuid?: string;
  readonly pages: readonly MokuroPage[];
}

type JsonObject = Record<string, unknown>;

const BLOCK_SOURCES: readonly MangaBlockSource[] = ['mokuro', 'vlm', 'manual'];
const ZERO_RECT: MangaRect = { left: 0, top: 0, right: 0, bottom: 0 };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce a JSON number (or numeric string) to a finite number, else `fallback`. */
function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Parse `[x1, y1, x2, y2]` into a rect; `undefined` when not a 4+-element array. */
function parseBox(value: unknown): MangaRect | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  return { left: asNumber(value[0]), top: asNumber(value[1]), right: asNumber(value[2]), bottom: asNumber(value[3]) };
}

/**
 * Parse `lines_coords` (lines → points → `[x, y]`). Non-array lines become
 * empty polygons (keeping line alignment); non-array / short points are skipped.
 */
function parseLinesCoords(value: unknown): MangaPoint[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((line): MangaPoint[] => {
    if (!Array.isArray(line)) return [];
    const points: MangaPoint[] = [];
    for (const p of line) {
      if (Array.isArray(p) && p.length >= 2) points.push([asNumber(p[0]), asNumber(p[1])]);
    }
    return points;
  });
}

/** Parse optional `regions: [{box, utf16_start, utf16_end}]`, dropping invalid entries. */
function parseRegions(value: unknown, textLength: number): MangaCharRegion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: MangaCharRegion[] = [];
  for (const r of value) {
    if (!isObject(r)) continue;
    const rect = parseBox(r['box']);
    const start = asNumber(r['utf16_start'], -1);
    const end = asNumber(r['utf16_end'], -1);
    if (!rect || !Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || end > textLength) continue;
    out.push({ rect, utf16Start: start, utf16End: end });
  }
  return out;
}

/**
 * Parse one OCR block. `zIndexKey` is `'z_index'` for manga.json (explicit
 * stacking) and `undefined` for `.mokuro` (stacking = array index).
 */
function parseBlock(raw: JsonObject, index: number, zIndexKey: string | undefined, warnings: string[], where: string): MangaBlock {
  let rect = parseBox(raw['box']);
  if (!rect) {
    warnings.push(`${where}: missing or malformed "box"; using an empty rect`);
    rect = ZERO_RECT;
  }
  const lines = Array.isArray(raw['lines']) ? raw['lines'].map((l) => (typeof l === 'string' ? l : l == null ? '' : String(l))) : [];
  const text = lines.join('');
  const zRaw = zIndexKey === undefined ? undefined : raw[zIndexKey];
  const sourceRaw = raw['source'];
  const source: MangaBlockSource = BLOCK_SOURCES.includes(sourceRaw as MangaBlockSource) ? (sourceRaw as MangaBlockSource) : 'mokuro';
  const linesCoords = parseLinesCoords(raw['lines_coords']);
  const regions = parseRegions(raw['regions'], text.length);
  const confidence = raw['confidence'];
  return {
    index,
    rect,
    vertical: raw['vertical'] === true,
    fontSize: asNumber(raw['font_size']),
    zIndex: typeof zRaw === 'number' && Number.isFinite(zRaw) ? Math.trunc(zRaw) : index,
    lines,
    text,
    ...(linesCoords ? { linesCoords } : {}),
    ...(regions ? { regions } : {}),
    source,
    ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {}),
  };
}

interface PageKeys {
  readonly path: string;
  readonly width: string;
  readonly height: string;
  readonly zIndex: string | undefined;
}

const MOKURO_KEYS: PageKeys = { path: 'img_path', width: 'img_width', height: 'img_height', zIndex: undefined };
const MANGA_JSON_KEYS: PageKeys = { path: 'url', width: 'width', height: 'height', zIndex: 'z_index' };

/** Shared page-list parser for both formats (they differ only in key names). */
function parsePages(rawPages: readonly unknown[], keys: PageKeys, warnings: string[]): MokuroPage[] {
  const pages: MokuroPage[] = [];
  rawPages.forEach((rawPage, rawIndex) => {
    if (!isObject(rawPage)) {
      warnings.push(`pages[${rawIndex}]: not an object; skipped`);
      return;
    }
    const rawPath = rawPage[keys.path];
    const relativePath = typeof rawPath === 'string' ? normaliseMangaUrl(rawPath) : '';
    if (relativePath === '') {
      warnings.push(`pages[${rawIndex}]: missing "${keys.path}"; skipped`);
      return;
    }
    const blocks: MangaBlock[] = [];
    const rawBlocks = rawPage['blocks'];
    if (Array.isArray(rawBlocks)) {
      rawBlocks.forEach((rawBlock, b) => {
        const where = `pages[${rawIndex}].blocks[${b}]`;
        if (!isObject(rawBlock)) {
          warnings.push(`${where}: not an object; skipped`);
          return;
        }
        blocks.push(parseBlock(rawBlock, blocks.length, keys.zIndex, warnings, where));
      });
    } else if (rawBlocks !== undefined) {
      warnings.push(`pages[${rawIndex}]: "blocks" is not an array; treated as empty`);
    }
    pages.push({
      index: pages.length,
      relativePath,
      width: asNumber(rawPage[keys.width]),
      height: asNumber(rawPage[keys.height]),
      blocks,
    });
  });
  return pages;
}

/** JSON.parse + top-level `{ pages: [] }` validation shared by both parsers. */
function parseTopLevel(json: string): { ok: true; root: JsonObject; pages: unknown[] } | { ok: false; error: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObject(decoded)) return { ok: false, error: 'top-level value is not an object' };
  const pages = decoded['pages'];
  if (!Array.isArray(pages)) return { ok: false, error: 'missing "pages" array' };
  return { ok: true, root: decoded, pages };
}

/**
 * Parse a mokuro v0.2+ `.mokuro` document (`title`, `title_uuid`, `volume`,
 * `volume_uuid`, `pages[].img_path|img_width|img_height|blocks[]`). Never throws.
 * `img_path` is normalised with {@link normaliseMangaUrl}; block `zIndex` is the
 * array index; `text = lines.join('')`.
 */
export function parseMokuro(json: string): ParseResult<MokuroDocument> {
  const top = parseTopLevel(json);
  if (!top.ok) return { ok: false, error: top.error, warnings: [] };
  const warnings: string[] = [];
  const pages = parsePages(top.pages, MOKURO_KEYS, warnings);
  const title = asNonEmptyString(top.root['title']);
  const titleUuid = asNonEmptyString(top.root['title_uuid']);
  const volume = asNonEmptyString(top.root['volume']);
  const volumeUuid = asNonEmptyString(top.root['volume_uuid']);
  const value: MokuroDocument = {
    ...(title !== undefined ? { title } : {}),
    ...(titleUuid !== undefined ? { titleUuid } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(volumeUuid !== undefined ? { volumeUuid } : {}),
    pages,
  };
  return { ok: true, value, warnings };
}

/**
 * Parse the Fushi-compatible `manga.json`
 * (`{pages:[{url,width,height,blocks:[{box,vertical,font_size,z_index,lines,lines_coords?,regions?,confidence?}]}]}`).
 * Inverse of {@link serialiseMangaJson}. Never throws.
 */
export function parseMangaJson(json: string): ParseResult<MokuroDocument> {
  const top = parseTopLevel(json);
  if (!top.ok) return { ok: false, error: top.error, warnings: [] };
  const warnings: string[] = [];
  const pages = parsePages(top.pages, MANGA_JSON_KEYS, warnings);
  const title = asNonEmptyString(top.root['title']);
  const volume = asNonEmptyString(top.root['volume']);
  const value: MokuroDocument = {
    ...(title !== undefined ? { title } : {}),
    ...(volume !== undefined ? { volume } : {}),
    pages,
  };
  return { ok: true, value, warnings };
}

const rectToBox = (r: MangaRect): number[] => [r.left, r.top, r.right, r.bottom];

/**
 * Serialise a document to the `manga.json` format read by {@link parseMangaJson}.
 * Optional fields (`lines_coords`, `regions`, `confidence`, non-`mokuro`
 * `source`) are only emitted when present. Region `rotation` is derived data
 * and is not persisted (same as Fushi).
 */
export function serialiseMangaJson(doc: MokuroDocument): string {
  const out = {
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    ...(doc.volume !== undefined ? { volume: doc.volume } : {}),
    pages: doc.pages.map((page) => ({
      url: page.relativePath,
      width: page.width,
      height: page.height,
      blocks: page.blocks.map((b) => ({
        box: rectToBox(b.rect),
        vertical: b.vertical,
        font_size: b.fontSize,
        z_index: b.zIndex,
        lines: b.lines,
        ...(b.linesCoords ? { lines_coords: b.linesCoords } : {}),
        ...(b.regions
          ? { regions: b.regions.map((r) => ({ box: rectToBox(r.rect), utf16_start: r.utf16Start, utf16_end: r.utf16End })) }
          : {}),
        ...(b.confidence !== undefined ? { confidence: b.confidence } : {}),
        ...(b.source !== 'mokuro' ? { source: b.source } : {}),
      })),
    })),
  };
  return JSON.stringify(out);
}

/**
 * Normalise a relative image path into a portable forward-slash URL: converts
 * `\` to `/`, drops leading `/` and `./` segments, and collapses repeated
 * slashes. Sub-directories are preserved (never flattened to a basename).
 */
export function normaliseMangaUrl(raw: string): string {
  let s = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  // Strip any mix of leading "/" and "./" prefixes.
  for (;;) {
    if (s.startsWith('/')) s = s.slice(1);
    else if (s.startsWith('./')) s = s.slice(2);
    else break;
  }
  return s;
}

/**
 * Page-root candidates tried by {@link resolveMokuroPageRoot}, in priority order:
 * `[]` (images beside the `.mokuro`, `img_path` already carries any prefix) then
 * `[volumeName]` (images in a sub-folder named like the `.mokuro`). Public so
 * error messages can list exactly where the resolver looked.
 */
export function mokuroPageRootCandidates(volumeName: string): string[][] {
  return volumeName.trim() === '' ? [[]] : [[], [volumeName]];
}

/** Join a page root (from {@link resolveMokuroPageRoot}) with a page `relativePath`. */
export function joinMokuroPageRoot(root: readonly string[], relativePath: string): string {
  return root.length === 0 ? relativePath : `${root.join('/')}/${relativePath}`;
}

/**
 * Resolve which directory the page images live in, relative to the `.mokuro`
 * file's directory. `exists(rel)` is an injected probe (filesystem stat,
 * archive listing, remote index …), so this is IO-free.
 *
 * Returns the first candidate under which **every** page exists; otherwise the
 * first candidate under which the first page exists (so downstream validation
 * can name the precise missing page); `undefined` when neither convention
 * finds the first page or the document has no pages.
 */
export function resolveMokuroPageRoot(
  doc: Pick<MokuroDocument, 'pages'>,
  volumeName: string,
  exists: (relativePath: string) => boolean,
): string[] | undefined {
  const first = doc.pages[0];
  if (!first) return undefined;
  let firstPageHit: string[] | undefined;
  for (const candidate of mokuroPageRootCandidates(volumeName)) {
    if (!exists(joinMokuroPageRoot(candidate, first.relativePath))) continue;
    firstPageHit ??= candidate;
    if (doc.pages.every((p) => exists(joinMokuroPageRoot(candidate, p.relativePath)))) return candidate;
  }
  return firstPageHit;
}
