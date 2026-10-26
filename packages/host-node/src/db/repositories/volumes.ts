/** `manga_volumes` + `manga_progress` repository. */
import type { EpochMs, Id, MangaReadingMode, MangaReadingProgress, MangaVolume, MangaVolumeKind } from '@kotori/core';
import { mangaImageUrlFor } from '../../shared/routes';
import type { Database } from '../sqlite';
import { all, nullable, num, one, opt, optNum, optStr, run, type Row } from './util';

export interface VolumeRecord {
  readonly id: Id;
  readonly title: string;
  readonly seriesTitle?: string;
  readonly volumeNumber?: number;
  readonly kind: MangaVolumeKind;
  readonly sourcePath: string;
  /** Directory page `relativePath`s resolve against. */
  readonly rootDir: string;
  readonly pageCount: number;
  readonly hasOcr: boolean;
  readonly coverIsSingle: boolean;
  readonly addedAt: EpochMs;
  /** Kotori-owned directory (extracted archive) deleted with the volume. */
  readonly managedDir?: string;
}

const SELECT = `SELECT v.*, p.page_index AS progress_page, p.updated_at AS progress_updated_at
  FROM manga_volumes v LEFT JOIN manga_progress p ON p.volume_id = v.id`;

export class VolumeRepository {
  constructor(private readonly db: Database) {}

  private map(r: Row): MangaVolume {
    const id = String(r['id']);
    const progress: MangaReadingProgress | undefined =
      r['progress_page'] === null || r['progress_page'] === undefined ? undefined : { pageIndex: num(r['progress_page']), updatedAt: num(r['progress_updated_at']) };
    const pageCount = num(r['page_count']);
    return {
      id,
      title: String(r['title']),
      kind: String(r['kind']) as MangaVolumeKind,
      sourcePath: String(r['source_path']),
      pageCount,
      hasOcr: num(r['has_ocr']) === 1,
      coverIsSingle: num(r['cover_is_single']) === 1,
      addedAt: num(r['added_at']),
      ...opt('seriesTitle', optStr(r['series_title'])),
      ...opt('volumeNumber', optNum(r['volume_number'])),
      ...opt('readingMode', optStr(r['reading_mode']) as MangaReadingMode | undefined),
      ...opt('coverUrl', pageCount > 0 ? mangaImageUrlFor(id, 0) : undefined),
      ...opt('progress', progress),
    };
  }

  list(): MangaVolume[] {
    return all(this.db, `${SELECT} ORDER BY COALESCE(v.series_title, v.title), v.volume_number, v.title`).map((r) => this.map(r));
  }

  get(id: Id): MangaVolume | undefined {
    const r = one(this.db, `${SELECT} WHERE v.id = ?`, id);
    return r ? this.map(r) : undefined;
  }

  /** Storage locations for file resolution / deletion. */
  locations(id: Id): { rootDir: string; managedDir?: string; sourcePath: string } | undefined {
    const r = one(this.db, 'SELECT root_dir, managed_dir, source_path FROM manga_volumes WHERE id = ?', id);
    if (!r) return undefined;
    return { rootDir: String(r['root_dir']), sourcePath: String(r['source_path']), ...opt('managedDir', optStr(r['managed_dir'])) };
  }

  upsert(rec: VolumeRecord): void {
    run(
      this.db,
      `INSERT INTO manga_volumes (id, title, series_title, volume_number, kind, source_path, root_dir, page_count, has_ocr, cover_is_single, added_at, managed_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, source_path = excluded.source_path, series_title = excluded.series_title, volume_number = excluded.volume_number,
         kind = excluded.kind, root_dir = excluded.root_dir, page_count = excluded.page_count, has_ocr = excluded.has_ocr,
         managed_dir = excluded.managed_dir`,
      rec.id,
      rec.title,
      nullable(rec.seriesTitle),
      nullable(rec.volumeNumber),
      rec.kind,
      rec.sourcePath,
      rec.rootDir,
      rec.pageCount,
      rec.hasOcr ? 1 : 0,
      rec.coverIsSingle ? 1 : 0,
      rec.addedAt,
      nullable(rec.managedDir),
    );
  }

  setReadingMode(id: Id, mode: MangaReadingMode | undefined): void {
    run(this.db, 'UPDATE manga_volumes SET reading_mode = ? WHERE id = ?', nullable(mode), id);
  }

  setCoverIsSingle(id: Id, single: boolean): void {
    run(this.db, 'UPDATE manga_volumes SET cover_is_single = ? WHERE id = ?', single ? 1 : 0, id);
  }

  setHasOcr(id: Id, hasOcr: boolean): void {
    run(this.db, 'UPDATE manga_volumes SET has_ocr = ? WHERE id = ?', hasOcr ? 1 : 0, id);
  }

  saveProgress(id: Id, progress: MangaReadingProgress): void {
    run(
      this.db,
      `INSERT INTO manga_progress (volume_id, page_index, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(volume_id) DO UPDATE SET page_index = excluded.page_index, updated_at = excluded.updated_at`,
      id,
      progress.pageIndex,
      progress.updatedAt,
    );
  }

  remove(id: Id): boolean {
    return run(this.db, 'DELETE FROM manga_volumes WHERE id = ?', id).changes > 0;
  }
}
