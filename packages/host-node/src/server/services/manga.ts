/** Server-side `MangaApi`: import (mokuro / archive / image dir), pages, reading state, VLM blocks. */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { KotoriError } from '@kotori/core';
import type { HostEvent, Id, MangaApi, MangaBlock, MangaPage, MangaReadingMode, MangaVolume } from '@kotori/core';
import type { Repositories } from '../../db/repositories';
import { transaction, type Database } from '../../db/sqlite';
import { importManga } from '../../library/manga-importer';
import { stableId } from '../util';

const READING_MODES: ReadonlySet<string> = new Set<MangaReadingMode>(['single-rtl', 'single-ltr', 'spread-rtl', 'spread-ltr', 'webtoon']);

export interface MangaServiceDeps {
  readonly db: Database;
  readonly repos: Repositories;
  readonly dataDir: string;
  readonly emit: (event: HostEvent) => void;
  readonly now?: () => number;
}

export interface NodeMangaService extends MangaApi {
  /** Absolute image path for `/api/manga/volumes/:id/pages/:i/image`. */
  imagePath(volumeId: Id, pageIndex: number): string;
}

export function createMangaService(deps: MangaServiceDeps): NodeMangaService {
  const { repos } = deps;
  const now = deps.now ?? Date.now;
  const managedRoot = resolve(deps.dataDir, 'manga');

  function requireVolume(id: Id): MangaVolume {
    const v = repos.volumes.get(id);
    if (!v) throw new KotoriError('not-found', `Volume ${id} not found`);
    return v;
  }

  function requirePage(volumeId: Id, pageIndex: number): MangaPage {
    requireVolume(volumeId);
    const p = repos.pages.get(volumeId, pageIndex);
    if (!p) throw new KotoriError('not-found', `Page ${pageIndex} of volume ${volumeId} not found`);
    return p;
  }

  return {
    async listVolumes() {
      return repos.volumes.list();
    },
    async getVolume(id) {
      return requireVolume(id);
    },
    async importVolume(request) {
      if (!isAbsolute(request.path)) throw new KotoriError('invalid-argument', 'Import path must be absolute');
      const sourcePath = resolve(request.path);
      const id = stableId('mv', sourcePath);
      const managedDir = join(managedRoot, id);
      const existing = repos.volumes.get(id);
      const imported = await importManga(sourcePath, { managedDir, ...(request.titleOverride !== undefined ? { titleOverride: request.titleOverride } : {}) });
      if (imported.pages.length === 0) throw new KotoriError('invalid-argument', 'Volume has no pages');
      transaction(deps.db, () => {
        repos.volumes.upsert({
          id,
          title: imported.title,
          kind: imported.kind,
          sourcePath,
          rootDir: imported.rootDir,
          pageCount: imported.pages.length,
          hasOcr: imported.hasOcr,
          coverIsSingle: existing?.coverIsSingle ?? true,
          addedAt: existing?.addedAt ?? now(),
          ...(imported.seriesTitle !== undefined ? { seriesTitle: imported.seriesTitle } : {}),
          ...(imported.volumeNumber !== undefined ? { volumeNumber: imported.volumeNumber } : {}),
          ...(imported.managedDir !== undefined ? { managedDir: imported.managedDir } : {}),
        });
        repos.pages.replaceAll(id, imported.pages);
      });
      for (const w of imported.warnings.slice(0, 5)) console.warn(`[kotori:manga] ${imported.title}: ${w}`);
      deps.emit({ type: 'library-changed', scope: 'manga' });
      return requireVolume(id);
    },
    async removeVolume(volumeId, deleteFiles = false) {
      requireVolume(volumeId);
      const loc = repos.volumes.locations(volumeId);
      repos.volumes.remove(volumeId);
      if (loc?.managedDir && resolve(loc.managedDir).startsWith(managedRoot + sep)) await rm(loc.managedDir, { recursive: true, force: true });
      if (deleteFiles && loc && existsSync(loc.sourcePath)) await rm(loc.sourcePath, { recursive: true, force: true });
      deps.emit({ type: 'library-changed', scope: 'manga' });
    },
    async getPage(volumeId, pageIndex) {
      return requirePage(volumeId, pageIndex);
    },
    async getPages(volumeId) {
      requireVolume(volumeId);
      return repos.pages.list(volumeId);
    },
    async setReadingMode(volumeId, mode) {
      requireVolume(volumeId);
      if (mode !== undefined && !READING_MODES.has(mode)) throw new KotoriError('invalid-argument', `Unknown reading mode ${String(mode)}`);
      repos.volumes.setReadingMode(volumeId, mode);
      return requireVolume(volumeId);
    },
    async setCoverIsSingle(volumeId, single) {
      requireVolume(volumeId);
      repos.volumes.setCoverIsSingle(volumeId, single);
      return requireVolume(volumeId);
    },
    async saveProgress(volumeId, progress) {
      const v = requireVolume(volumeId);
      if (!Number.isInteger(progress.pageIndex) || progress.pageIndex < 0 || progress.pageIndex >= v.pageCount) {
        throw new KotoriError('invalid-argument', `pageIndex out of range 0..${v.pageCount - 1}`);
      }
      repos.volumes.saveProgress(volumeId, progress);
    },
    async addBlocks(volumeId, pageIndex, blocks) {
      const page = requirePage(volumeId, pageIndex);
      const start = page.blocks.length;
      const added: MangaBlock[] = blocks.map((b, i) => ({ ...b, index: start + i, zIndex: b.zIndex ?? start + i, text: b.text ?? b.lines.join('') }));
      repos.pages.setBlocks(volumeId, pageIndex, [...page.blocks, ...added]);
      repos.volumes.setHasOcr(volumeId, true);
      return requirePage(volumeId, pageIndex);
    },
    imagePath(volumeId, pageIndex) {
      const loc = repos.volumes.locations(volumeId);
      const rel = repos.pages.relativePath(volumeId, pageIndex);
      if (!loc || rel === undefined) throw new KotoriError('not-found', `Page ${pageIndex} of volume ${volumeId} not found`);
      const root = resolve(loc.rootDir);
      const abs = resolve(root, ...rel.split('/'));
      if (!abs.startsWith(root + sep)) throw new KotoriError('invalid-argument', 'Page path escapes volume root');
      return abs;
    },
  };
}
