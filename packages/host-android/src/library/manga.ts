/**
 * Manga library over the Capacitor filesystem + IndexedDB.
 *
 * Import paths:
 *  - `.mokuro` — images beside the file or in a same-named sub-folder
 *    (`resolveMokuroPageRoot`); pages are referenced in place.
 *  - `.cbz` / `.zip` — extracted with fflate (core `cbz.ts`) into
 *    `manga/{volumeId}/` exactly once (re-import reuses the extraction).
 *  - image directory — natural-sorted images referenced in place; a directory
 *    holding a single `.mokuro` is imported as that `.mokuro`.
 * `imageUrl = convertFileSrc(imageRoot + relativePath)`.
 */
import type { MangaApi, MangaBlock, MangaPage, MangaReadingProgress, MangaVolume } from '@kotori/core';
import {
  KotoriError,
  compareNatural,
  listArchiveImages,
  parseMokuro,
  parseVolumeName,
  readArchiveEntry,
  readImageSize,
  resolveMokuroPageRoot,
  mokuroPageRootCandidates,
  joinMokuroPageRoot,
} from '../adapters/core';
import { KeyedDebouncer, stableId, type HostContext } from '../context';
import type { FsEntry } from '../deps';
import { basename, dirname, extname, isWithin, joinPath, stem } from '../paths';
import { readText } from '../storage/files';
import type { StoredPage, StoredVolume } from '../storage/idb';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);

export interface MangaLibrary extends MangaApi {
  flush(): Promise<void>;
}

type Draft = Omit<StoredVolume, 'id' | 'addedAt' | 'coverIsSingle'>;

export function createMangaLibrary(ctx: HostContext): MangaLibrary {
  const { db, deps, dirs } = ctx;

  const progress = new KeyedDebouncer<MangaReadingProgress>(deps.progressDebounceMs, async (volumeId, value) => {
    const tx = db.transaction('volumes', 'readwrite');
    const volume = await tx.store.get(volumeId);
    if (volume) await tx.store.put({ ...volume, progress: value });
    await tx.done;
  });

  const imageUrl = (volume: StoredVolume, relativePath: string): string => deps.convertFileSrc(joinPath(volume.imageRoot, relativePath));

  const toVolume = (stored: StoredVolume): MangaVolume => {
    const { imageRoot: _root, ownsFiles: _owns, coverRelativePath, ...rest } = stored;
    const pending = progress.peek(stored.id);
    return {
      ...rest,
      ...(pending === undefined ? {} : { progress: pending }),
      ...(coverRelativePath === undefined ? {} : { coverUrl: imageUrl(stored, coverRelativePath) }),
    };
  };

  const toPage = (volume: StoredVolume, page: StoredPage): MangaPage => {
    const { volumeId: _v, ...rest } = page;
    return { ...rest, imageUrl: imageUrl(volume, page.relativePath) };
  };

  const requireVolume = async (volumeId: string): Promise<StoredVolume> => {
    const volume = await db.get('volumes', volumeId);
    if (!volume) throw new KotoriError('not-found', `volume not found: ${volumeId}`);
    return volume;
  };

  /** Width/height from the image header when the producer did not report them. */
  const sizeOf = async (path: string): Promise<{ width: number; height: number }> => {
    try {
      return readImageSize(await deps.fs.readFile(path)) ?? { width: 0, height: 0 };
    } catch {
      return { width: 0, height: 0 };
    }
  };

  /** Persist a volume + pages (replacing any previous import of the same id). */
  const save = async (id: string, draft: Draft, pages: readonly Omit<StoredPage, 'volumeId'>[]): Promise<MangaVolume> => {
    const existing = await db.get('volumes', id);
    const volume: StoredVolume = {
      ...draft,
      id,
      addedAt: existing?.addedAt ?? deps.now(),
      coverIsSingle: existing?.coverIsSingle ?? true,
      ...(existing?.readingMode === undefined ? {} : { readingMode: existing.readingMode }),
      ...(existing?.progress === undefined ? {} : { progress: existing.progress }),
      ...(pages[0] === undefined ? {} : { coverRelativePath: pages[0].relativePath }),
    };
    const oldKeys = await db.getAllKeysFromIndex('pages', 'byVolume', id);
    const tx = db.transaction(['volumes', 'pages'], 'readwrite');
    await Promise.all([
      ...oldKeys.map((key) => tx.objectStore('pages').delete(key)),
      tx.objectStore('volumes').put(volume),
      ...pages.map((p) => tx.objectStore('pages').put({ ...p, volumeId: id })),
    ]);
    await tx.done;
    ctx.emit({ type: 'library-changed', scope: 'manga' });
    return toVolume(volume);
  };

  const importMokuro = async (path: string, titleOverride: string | undefined): Promise<MangaVolume> => {
    const parsed = parseMokuro(await readText(deps.fs, path));
    if (!parsed.ok) throw new KotoriError('parse', `invalid .mokuro: ${parsed.error}`, { details: { warnings: parsed.warnings } });
    const doc = parsed.value;
    const volumeName = stem(path);
    const parent = dirname(path);
    // `resolveMokuroPageRoot` takes a sync `exists`: list every directory the
    // candidate roots could hold pages in (one readdir per directory, not per page).
    const known = new Set<string>();
    const listed = new Set<string>();
    for (const root of mokuroPageRootCandidates(volumeName)) {
      for (const page of doc.pages) {
        const rel = joinMokuroPageRoot(root, page.relativePath);
        const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        if (listed.has(relDir)) continue;
        listed.add(relDir);
        const entries = await deps.fs.readdir(joinPath(parent, relDir)).catch(() => []);
        for (const e of entries) if (e.kind === 'file') known.add(relDir === '' ? e.name : `${relDir}/${e.name}`);
      }
    }
    const root = resolveMokuroPageRoot(doc, volumeName, (rel) => known.has(rel));
    if (root === undefined) throw new KotoriError('not-found', `page images for "${volumeName}" not found beside the .mokuro or in "${volumeName}/"`);
    const imageRoot = joinPath(parent, ...root);
    const pages: Omit<StoredPage, 'volumeId'>[] = [];
    for (const page of doc.pages) {
      const size = page.width > 0 && page.height > 0 ? { width: page.width, height: page.height } : await sizeOf(joinPath(imageRoot, page.relativePath));
      pages.push({ ...page, ...size });
    }
    const name = parseVolumeName(volumeName);
    const seriesTitle = doc.title ?? name.seriesTitle;
    return save(
      stableId('vol', path),
      {
        title: titleOverride ?? doc.volume ?? volumeName,
        ...(seriesTitle === '' ? {} : { seriesTitle }),
        ...(name.volumeNumber === undefined ? {} : { volumeNumber: name.volumeNumber }),
        kind: 'mokuro',
        sourcePath: path,
        pageCount: pages.length,
        hasOcr: true,
        imageRoot,
        ownsFiles: false,
      },
      pages,
    );
  };

  const importArchive = async (path: string, titleOverride: string | undefined): Promise<MangaVolume> => {
    const id = stableId('vol', path);
    const outDir = joinPath(dirs.manga, id);
    const existing = await db.get('volumes', id);
    const existingPages = existing ? await db.getAllFromIndex('pages', 'byVolume', id) : [];
    let pages: Omit<StoredPage, 'volumeId'>[];
    if (existing && existingPages.length > 0 && (await deps.fs.stat(outDir))) {
      // Already extracted once: keep files, refresh metadata only.
      pages = existingPages.sort((a, b) => a.index - b.index).map(({ volumeId: _v, ...p }) => p);
    } else {
      const bytes = await deps.fs.readFile(path);
      const entries = listArchiveImages(bytes);
      if (entries.length === 0) throw new KotoriError('parse', `no images found in ${basename(path)}`);
      await deps.fs.remove(outDir);
      pages = [];
      for (const entry of entries) {
        const data = readArchiveEntry(bytes, entry);
        await deps.fs.writeFile(joinPath(outDir, entry.path), data);
        const size = readImageSize(data) ?? { width: 0, height: 0 };
        pages.push({ index: pages.length, relativePath: entry.path, ...size, blocks: [] });
      }
    }
    const name = parseVolumeName(stem(path));
    return save(
      id,
      {
        title: titleOverride ?? stem(path),
        ...(name.seriesTitle === '' ? {} : { seriesTitle: name.seriesTitle }),
        ...(name.volumeNumber === undefined ? {} : { volumeNumber: name.volumeNumber }),
        kind: 'images',
        sourcePath: path,
        pageCount: pages.length,
        hasOcr: pages.some((p) => p.blocks.length > 0),
        imageRoot: outDir,
        ownsFiles: true,
      },
      pages,
    );
  };

  const importDirectory = async (path: string, titleOverride: string | undefined): Promise<MangaVolume> => {
    const children = await deps.fs.readdir(path);
    const mokuros = children.filter((c) => c.kind === 'file' && extname(c.name) === 'mokuro');
    const only = mokuros[0];
    if (mokuros.length === 1 && only) return importMokuro(only.path, titleOverride);
    const images: FsEntry[] = children.filter((c) => c.kind === 'file' && !c.name.startsWith('.') && IMAGE_EXT.has(extname(c.name)));
    if (images.length === 0) throw new KotoriError('invalid-argument', `no images, .mokuro or archive found in ${path}`);
    images.sort((a, b) => compareNatural(a.name, b.name));
    const pages: Omit<StoredPage, 'volumeId'>[] = [];
    for (const image of images) {
      pages.push({ index: pages.length, relativePath: image.name, ...(await sizeOf(image.path)), blocks: [] });
    }
    const name = parseVolumeName(basename(path));
    const existingId = stableId('vol', path);
    const existingPages = await db.getAllFromIndex('pages', 'byVolume', existingId);
    // Keep VLM blocks saved on previous imports of the same folder.
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const prev = existingPages.find((e) => e.relativePath === p?.relativePath);
      if (p && prev) pages[i] = { ...p, blocks: prev.blocks };
    }
    return save(
      existingId,
      {
        title: titleOverride ?? basename(path),
        ...(name.seriesTitle === '' ? {} : { seriesTitle: name.seriesTitle }),
        ...(name.volumeNumber === undefined ? {} : { volumeNumber: name.volumeNumber }),
        kind: 'images',
        sourcePath: path,
        pageCount: pages.length,
        hasOcr: pages.some((p) => p.blocks.length > 0),
        imageRoot: path,
        ownsFiles: false,
      },
      pages,
    );
  };

  const getPageRecord = async (volumeId: string, pageIndex: number): Promise<StoredPage> => {
    const page = await db.get('pages', [volumeId, pageIndex]);
    if (!page) throw new KotoriError('not-found', `page ${pageIndex} of ${volumeId} not found`);
    return page;
  };

  return {
    async listVolumes() {
      const all = await db.getAll('volumes');
      return all
        .sort((a, b) => compareNatural(a.seriesTitle ?? a.title, b.seriesTitle ?? b.title) || (a.volumeNumber ?? 0) - (b.volumeNumber ?? 0))
        .map(toVolume);
    },
    async getVolume(volumeId) {
      return toVolume(await requireVolume(volumeId));
    },
    async importVolume(request) {
      if (request.path === '') throw new KotoriError('invalid-argument', 'path is required');
      const ext = extname(request.path);
      if (ext === 'mokuro') return importMokuro(request.path, request.titleOverride);
      if (ext === 'cbz' || ext === 'zip') return importArchive(request.path, request.titleOverride);
      const entry = await deps.fs.stat(request.path);
      if (!entry) throw new KotoriError('not-found', `path not found: ${request.path}`);
      if (entry.kind === 'dir') return importDirectory(request.path, request.titleOverride);
      throw new KotoriError('invalid-argument', `unsupported manga source: ${basename(request.path)}`);
    },
    async removeVolume(volumeId, deleteFiles = false) {
      const volume = await requireVolume(volumeId);
      const keys = await db.getAllKeysFromIndex('pages', 'byVolume', volumeId);
      const tx = db.transaction(['volumes', 'pages'], 'readwrite');
      await Promise.all([tx.objectStore('volumes').delete(volumeId), ...keys.map((k) => tx.objectStore('pages').delete(k))]);
      await tx.done;
      if (volume.ownsFiles && isWithin(volume.imageRoot, dirs.manga)) await deps.fs.remove(volume.imageRoot);
      if (deleteFiles) {
        await deps.fs.remove(volume.sourcePath);
        if (volume.kind === 'mokuro' && volume.imageRoot !== dirname(volume.sourcePath)) await deps.fs.remove(volume.imageRoot);
      }
      ctx.emit({ type: 'library-changed', scope: 'manga' });
    },
    async getPage(volumeId, pageIndex) {
      const volume = await requireVolume(volumeId);
      return toPage(volume, await getPageRecord(volumeId, pageIndex));
    },
    async getPages(volumeId) {
      const volume = await requireVolume(volumeId);
      const pages = await db.getAllFromIndex('pages', 'byVolume', volumeId);
      return pages.sort((a, b) => a.index - b.index).map((p) => toPage(volume, p));
    },
    async setReadingMode(volumeId, mode) {
      const { readingMode: _old, ...volume } = await requireVolume(volumeId);
      const next: StoredVolume = mode === undefined ? volume : { ...volume, readingMode: mode };
      await db.put('volumes', next);
      return toVolume(next);
    },
    async setCoverIsSingle(volumeId, single) {
      const next: StoredVolume = { ...(await requireVolume(volumeId)), coverIsSingle: single };
      await db.put('volumes', next);
      return toVolume(next);
    },
    saveProgress(volumeId, value) {
      return progress.schedule(volumeId, value);
    },
    async addBlocks(volumeId, pageIndex, blocks) {
      const volume = await requireVolume(volumeId);
      const page = await getPageRecord(volumeId, pageIndex);
      const appended: MangaBlock[] = blocks.map((b, k) => ({ ...b, index: page.blocks.length + k }));
      const next: StoredPage = { ...page, blocks: [...page.blocks, ...appended] };
      const tx = db.transaction(['volumes', 'pages'], 'readwrite');
      await Promise.all([tx.objectStore('pages').put(next), volume.hasOcr ? Promise.resolve() : tx.objectStore('volumes').put({ ...volume, hasOcr: true })]);
      await tx.done;
      return toPage(volume, next);
    },
    flush: () => progress.flushAll(),
  };
}
