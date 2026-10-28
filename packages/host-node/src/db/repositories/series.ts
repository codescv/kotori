/** `anime_series` repository. */
import type { AnimeSeries, EpochMs, Id } from '@kotori/core';
import type { Database } from '../sqlite';
import { all, nullable, num, one, opt, optNum, optStr, run, type Row } from './util';

export interface SeriesRecord {
  readonly id: Id;
  readonly title: string;
  readonly sourcePath: string;
  readonly coverPath?: string;
  readonly addedAt: EpochMs;
  readonly jimakuEntryId?: number;
  readonly anilistId?: number;
}

const SELECT = `SELECT s.*, (SELECT COUNT(*) FROM anime_episodes e WHERE e.series_id = s.id) AS episode_count FROM anime_series s`;

export class SeriesRepository {
  constructor(private readonly db: Database) {}

  private map(r: Row): AnimeSeries {
    const coverPath = optStr(r['cover_path']);
    const coverUrl =
      coverPath === undefined
        ? undefined
        : /^https?:\/\//i.test(coverPath)
          ? coverPath
          : `/api/anime/series/${encodeURIComponent(String(r['id']))}/cover`;
    return {
      id: String(r['id']),
      title: String(r['title']),
      sourcePath: String(r['source_path']),
      episodeCount: num(r['episode_count'] ?? 0),
      addedAt: num(r['added_at']),
      ...opt('coverUrl', coverUrl),
      ...opt('lastWatchedEpisodeId', optStr(r['last_watched_episode_id'])),
      ...opt('lastWatchedAt', optNum(r['last_watched_at'])),
      ...opt('jimakuEntryId', optNum(r['jimaku_entry_id'])),
      ...opt('anilistId', optNum(r['anilist_id'])),
    };
  }

  list(): AnimeSeries[] {
    return all(this.db, `${SELECT} ORDER BY COALESCE(s.last_watched_at, s.added_at) DESC, s.title`).map((r) => this.map(r));
  }

  get(id: Id): AnimeSeries | undefined {
    const r = one(this.db, `${SELECT} WHERE s.id = ?`, id);
    return r ? this.map(r) : undefined;
  }

  getByPath(sourcePath: string): AnimeSeries | undefined {
    const r = one(this.db, `${SELECT} WHERE s.source_path = ?`, sourcePath);
    return r ? this.map(r) : undefined;
  }

  coverPath(id: Id): string | undefined {
    return optStr(one(this.db, 'SELECT cover_path FROM anime_series WHERE id = ?', id)?.['cover_path']);
  }

  upsert(rec: SeriesRecord): void {
    run(
      this.db,
      `INSERT INTO anime_series (id, title, source_path, cover_path, added_at, jimaku_entry_id, anilist_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, source_path = excluded.source_path,
         cover_path = COALESCE(excluded.cover_path, anime_series.cover_path)`,
      rec.id,
      rec.title,
      rec.sourcePath,
      nullable(rec.coverPath),
      rec.addedAt,
      nullable(rec.jimakuEntryId),
      nullable(rec.anilistId),
    );
  }

  setJimaku(id: Id, jimakuEntryId: number | undefined, anilistId?: number): void {
    run(this.db, 'UPDATE anime_series SET jimaku_entry_id = ?, anilist_id = COALESCE(?, anilist_id) WHERE id = ?', nullable(jimakuEntryId), nullable(anilistId), id);
  }

  setMetadata(id: Id, fields: { readonly title?: string; readonly coverPath?: string; readonly anilistId?: number }): void {
    run(
      this.db,
      `UPDATE anime_series
       SET title = COALESCE(?, title),
           cover_path = COALESCE(?, cover_path),
           anilist_id = COALESCE(?, anilist_id)
       WHERE id = ?`,
      nullable(fields.title),
      nullable(fields.coverPath),
      nullable(fields.anilistId),
      id,
    );
  }

  update(
    id: Id,
    patch: { readonly title?: string; readonly coverPath?: string | null; readonly anilistId?: number | null },
  ): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      args.push(patch.title);
    }
    if (patch.coverPath !== undefined) {
      sets.push('cover_path = ?');
      args.push(patch.coverPath);
    }
    if (patch.anilistId !== undefined) {
      sets.push('anilist_id = ?');
      args.push(patch.anilistId);
    }
    if (sets.length === 0) return;
    args.push(id);
    run(this.db, `UPDATE anime_series SET ${sets.join(', ')} WHERE id = ?`, ...args);
  }

  touchWatched(id: Id, episodeId: Id, at: EpochMs): void {
    run(this.db, 'UPDATE anime_series SET last_watched_episode_id = ?, last_watched_at = ? WHERE id = ?', episodeId, at, id);
  }

  remove(id: Id): boolean {
    return run(this.db, 'DELETE FROM anime_series WHERE id = ?', id).changes > 0;
  }
}
