/**
 * Manga volume importer: `.mokuro` (+ images beside it, in a same-named
 * subfolder, or in a same-named `.zip`/`.cbz`), `.cbz`/`.zip` archives
 * (extracted once into a Kotori-managed directory) and plain image folders.
 * Produces a volume description + page rows; persistence is the caller's job.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { KotoriError } from '@kotori/core';
import type { MangaBlock, MangaVolumeKind } from '@kotori/core';
import { unzipSync } from 'fflate';
import {
  compareNatural,
  parseMokuro,
  parseVolumeName,
  readImageSize,
  resolveMokuroPageRoot,
} from '@kotori/core';
import type { PageRecord } from '../db/repositories';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|jxl)$/i;

/** Page-image entries of an archive (skips `__MACOSX` and dot-files), inflated in one pass. */
function extractArchiveImages(bytes: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  const isImage = (name: string): boolean => IMAGE_EXT.test(name) && !name.startsWith('__MACOSX/') && !name.split('/').some((seg) => seg.startsWith('.'));
  const out = unzipSync(bytes, { filter: (file) => isImage(file.name) });
  return Object.keys(out)
    .sort(compareNatural)
    .map((path) => ({ path, data: out[path] as Uint8Array }));
}
const ARCHIVE_EXT = /\.(cbz|zip)$/i;

export interface ImportedVolume {
  readonly kind: MangaVolumeKind;
  readonly title: string;
  readonly seriesTitle?: string;
  readonly volumeNumber?: number;
  readonly sourcePath: string;
  /** Directory against which page `relativePath`s resolve. */
  readonly rootDir: string;
  /** Set when Kotori extracted files and owns this directory. */
  readonly managedDir?: string;
  readonly hasOcr: boolean;
  readonly pages: readonly PageRecord[];
  readonly warnings: readonly string[];
}

export interface ImportOptions {
  /** Where archives get extracted (`{dataDir}/manga/{volumeId}`). */
  readonly managedDir: string;
  readonly titleOverride?: string;
}

/** Read the first 64 KiB and sniff the image size. */
async function sniffSize(path: string): Promise<{ width: number; height: number }> {
  const fh = await open(path, 'r');
  try {
    const buf = new Uint8Array(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return readImageSize(buf.subarray(0, bytesRead)) ?? { width: 0, height: 0 };
  } finally {
    await fh.close();
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Write archive images under `targetDir`, refusing path traversal. */
async function extractTo(bytes: Uint8Array, targetDir: string): Promise<Array<{ path: string; size: { width: number; height: number } }>> {
  const root = resolve(targetDir);
  const out: Array<{ path: string; size: { width: number; height: number } }> = [];
  for (const entry of extractArchiveImages(bytes)) {
    const dest = resolve(root, entry.path);
    if (!dest.startsWith(root + sep)) continue; // zip-slip guard
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, entry.data);
    out.push({ path: toPosix(relative(root, dest)), size: readImageSize(entry.data) ?? { width: 0, height: 0 } });
  }
  return out;
}

function nameParts(sourcePath: string, titleOverride: string | undefined): { title: string; seriesTitle?: string; volumeNumber?: number } {
  const base = basename(sourcePath).replace(/\.(mokuro|cbz|zip)$/i, '');
  const parsed = parseVolumeName(base);
  return {
    title: titleOverride ?? base,
    seriesTitle: parsed.seriesTitle,
    ...(parsed.volumeNumber !== undefined ? { volumeNumber: parsed.volumeNumber } : {}),
  };
}

/** `.mokuro` import with Fushi-compatible page-root resolution. */
export async function importMokuro(path: string, options: ImportOptions): Promise<ImportedVolume> {
  const parsed = parseMokuro(await readFile(path, 'utf8'));
  if (!parsed.ok) throw new KotoriError('parse', `Invalid .mokuro file: ${parsed.error}`, { details: { path } });
  const doc = parsed.value;
  const dir = dirname(path);
  const volumeName = basename(path, extname(path));
  const warnings = [...parsed.warnings];
  let rootDir: string;
  let managedDir: string | undefined;
  let stripPrefix: string | undefined;
  const root = resolveMokuroPageRoot(doc, volumeName, (rel) => existsSync(join(dir, ...rel.split('/'))));
  if (root) {
    rootDir = join(dir, ...root);
  } else {
    // Images packed in `{volumeName}.zip|.cbz` next to the `.mokuro`.
    const archive = ['.cbz', '.zip'].map((ext) => join(dir, volumeName + ext)).find((p) => existsSync(p));
    if (!archive) throw new KotoriError('not-found', `Page images for ${basename(path)} not found (beside it, in ./${volumeName}/ or ${volumeName}.zip)`);
    await extractTo(await readFile(archive), options.managedDir);
    managedDir = options.managedDir;
    const first = doc.pages[0]?.relativePath ?? '';
    // Archives sometimes nest the pages inside a `{volumeName}/` or `{doc.volume}/` folder, or omit the folder prefix when `.mokuro` has one.
    if (existsSync(join(managedDir, ...first.split('/')))) {
      rootDir = managedDir;
    } else if (existsSync(join(managedDir, volumeName, ...first.split('/')))) {
      rootDir = join(managedDir, volumeName);
    } else if (doc.volume && existsSync(join(managedDir, doc.volume, ...first.split('/')))) {
      rootDir = join(managedDir, doc.volume);
    } else if (first.includes('/') && existsSync(join(managedDir, ...first.slice(first.indexOf('/') + 1).split('/')))) {
      rootDir = managedDir;
      stripPrefix = first.slice(0, first.indexOf('/') + 1);
    } else {
      const subdirs = (await readdir(managedDir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
      const firstStripped = first.includes('/') ? first.slice(first.indexOf('/') + 1) : first;
      const matchedSub = subdirs.find((d) => existsSync(join(managedDir as string, d.name, ...firstStripped.split('/'))));
      if (matchedSub) {
        rootDir = join(managedDir, matchedSub.name);
        if (first.includes('/')) stripPrefix = first.slice(0, first.indexOf('/') + 1);
      } else {
        rootDir = join(managedDir, volumeName);
      }
    }
  }
  const pages: PageRecord[] = [];
  for (const p of doc.pages) {
    let { width, height } = p;
    const relPath = stripPrefix && p.relativePath.startsWith(stripPrefix) ? p.relativePath.slice(stripPrefix.length) : p.relativePath;
    const file = join(rootDir, ...relPath.split('/'));
    if ((!width || !height) && existsSync(file)) ({ width, height } = await sniffSize(file));
    if (!existsSync(file)) warnings.push(`missing page image ${relPath}`);
    pages.push({ index: pages.length, relativePath: relPath, width, height, blocks: p.blocks as MangaBlock[] });
  }
  const names = nameParts(path, options.titleOverride);
  return {
    kind: 'mokuro',
    ...names,
    ...(options.titleOverride === undefined && doc.volume ? { title: doc.volume } : {}),
    ...(doc.title ? { seriesTitle: doc.title } : {}),
    sourcePath: path,
    rootDir,
    ...(managedDir ? { managedDir } : {}),
    hasOcr: true,
    pages,
    warnings,
  };
}

/** `.cbz` / `.zip` import: extracted once to `managedDir`. */
export async function importArchive(path: string, options: ImportOptions): Promise<ImportedVolume> {
  const bytes = await readFile(path);
  let extracted: Array<{ path: string; size: { width: number; height: number } }>;
  try {
    extracted = await extractTo(bytes, options.managedDir);
  } catch (error) {
    throw new KotoriError('parse', `Cannot read archive ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (extracted.length === 0) throw new KotoriError('invalid-argument', `No images found in ${basename(path)}`);
  extracted.sort((a, b) => compareNatural(a.path, b.path));
  return {
    kind: 'images',
    ...nameParts(path, options.titleOverride),
    sourcePath: path,
    rootDir: options.managedDir,
    managedDir: options.managedDir,
    hasOcr: false,
    pages: extracted.map((e, index) => ({ index, relativePath: e.path, width: e.size.width, height: e.size.height, blocks: [] })),
    warnings: [],
  };
}

/** Image folder import (one level of sub-folders, natural order). */
export async function importImageDir(path: string, options: ImportOptions): Promise<ImportedVolume> {
  const rels: string[] = [];
  for (const name of await readdir(path)) {
    if (name.startsWith('.')) continue;
    const full = join(path, name);
    const st = await stat(full);
    if (st.isFile() && IMAGE_EXT.test(name)) rels.push(name);
    else if (st.isDirectory()) {
      for (const sub of await readdir(full)) if (IMAGE_EXT.test(sub) && !sub.startsWith('.')) rels.push(`${name}/${sub}`);
    }
  }
  if (rels.length === 0) throw new KotoriError('invalid-argument', `No images found in ${path}`);
  rels.sort(compareNatural);
  const pages: PageRecord[] = [];
  for (const rel of rels) {
    const size = await sniffSize(join(path, ...rel.split('/')));
    pages.push({ index: pages.length, relativePath: rel, width: size.width, height: size.height, blocks: [] });
  }
  return { kind: 'images', ...nameParts(path, options.titleOverride), sourcePath: path, rootDir: path, hasOcr: false, pages, warnings: [] };
}

/** Dispatch on path type: `.mokuro` / archive / directory (a lone `.mokuro` inside a dir wins). */
export async function importManga(path: string, options: ImportOptions): Promise<ImportedVolume> {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new KotoriError('not-found', `Path not found: ${path}`);
  }
  if (st.isDirectory()) {
    const mokuros = (await readdir(path)).filter((n) => n.toLowerCase().endsWith('.mokuro'));
    if (mokuros.length === 1 && mokuros[0]) return importMokuro(join(path, mokuros[0]), options);
    return importImageDir(path, options);
  }
  if (/\.mokuro$/i.test(path)) return importMokuro(path, options);
  if (ARCHIVE_EXT.test(path)) return importArchive(path, options);
  throw new KotoriError('invalid-argument', `Unsupported manga source: ${basename(path)} (expected .mokuro, .cbz, .zip or a folder)`);
}
