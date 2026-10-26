/** `manga_pages` repository (page metadata + OCR blocks as JSON). */
import type { Id, MangaBlock, MangaPage } from '@kotori/core';
import { mangaImageUrlFor } from '../../shared/routes';
import { transaction, type Database } from '../sqlite';
import { all, num, one, run, type Row } from './util';

export interface PageRecord {
  readonly index: number;
  readonly relativePath: string;
  readonly width: number;
  readonly height: number;
  readonly blocks: readonly MangaBlock[];
}

export class PageRepository {
  constructor(private readonly db: Database) {}

  private map(volumeId: Id, r: Row): MangaPage {
    const index = num(r['page_index']);
    return {
      index,
      relativePath: String(r['relative_path']),
      width: num(r['width']),
      height: num(r['height']),
      blocks: JSON.parse(String(r['blocks_json'])) as MangaBlock[],
      imageUrl: mangaImageUrlFor(volumeId, index),
    };
  }

  list(volumeId: Id): MangaPage[] {
    return all(this.db, 'SELECT * FROM manga_pages WHERE volume_id = ? ORDER BY page_index', volumeId).map((r) => this.map(volumeId, r));
  }

  get(volumeId: Id, pageIndex: number): MangaPage | undefined {
    const r = one(this.db, 'SELECT * FROM manga_pages WHERE volume_id = ? AND page_index = ?', volumeId, pageIndex);
    return r ? this.map(volumeId, r) : undefined;
  }

  relativePath(volumeId: Id, pageIndex: number): string | undefined {
    const r = one(this.db, 'SELECT relative_path FROM manga_pages WHERE volume_id = ? AND page_index = ?', volumeId, pageIndex);
    return r ? String(r['relative_path']) : undefined;
  }

  /** Replace all pages of a volume. */
  replaceAll(volumeId: Id, pages: readonly PageRecord[]): void {
    transaction(this.db, () => {
      run(this.db, 'DELETE FROM manga_pages WHERE volume_id = ?', volumeId);
      const stmt = this.db.prepare('INSERT INTO manga_pages (volume_id, page_index, relative_path, width, height, blocks_json) VALUES (?, ?, ?, ?, ?, ?)');
      for (const p of pages) stmt.run(volumeId, p.index, p.relativePath, Math.round(p.width), Math.round(p.height), JSON.stringify(p.blocks));
    });
  }

  setBlocks(volumeId: Id, pageIndex: number, blocks: readonly MangaBlock[]): void {
    run(this.db, 'UPDATE manga_pages SET blocks_json = ? WHERE volume_id = ? AND page_index = ?', JSON.stringify(blocks), volumeId, pageIndex);
  }

  setSize(volumeId: Id, pageIndex: number, width: number, height: number): void {
    run(this.db, 'UPDATE manga_pages SET width = ?, height = ? WHERE volume_id = ? AND page_index = ?', width, height, volumeId, pageIndex);
  }
}
