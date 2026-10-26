/** `download_tasks` repository (task JSON + indexed status). */
import type { DownloadTask, Id } from '@kotori/core';
import type { Database } from '../sqlite';
import { all, one, run } from './util';

export class DownloadRepository {
  constructor(private readonly db: Database) {}

  list(): DownloadTask[] {
    return all(this.db, 'SELECT json FROM download_tasks ORDER BY created_at DESC').map((r) => JSON.parse(String(r['json'])) as DownloadTask);
  }

  get(id: Id): DownloadTask | undefined {
    const r = one(this.db, 'SELECT json FROM download_tasks WHERE id = ?', id);
    return r ? (JSON.parse(String(r['json'])) as DownloadTask) : undefined;
  }

  /** Upsert a task; `autoImport` is kept as-is on update when omitted. */
  put(task: DownloadTask, autoImport?: boolean): void {
    run(
      this.db,
      `INSERT INTO download_tasks (id, kind, status, json, created_at, updated_at, auto_import) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json, created_at = excluded.created_at,
         updated_at = excluded.updated_at, auto_import = COALESCE(?, download_tasks.auto_import)`,
      task.id,
      task.kind,
      task.status,
      JSON.stringify(task),
      task.createdAt,
      task.updatedAt,
      autoImport ? 1 : 0,
      autoImport === undefined ? null : autoImport ? 1 : 0,
    );
  }

  /** Persisted auto-import flag (false when unknown). */
  autoImport(id: Id): boolean {
    return one(this.db, 'SELECT auto_import FROM download_tasks WHERE id = ?', id)?.['auto_import'] === 1;
  }

  remove(id: Id): boolean {
    return run(this.db, 'DELETE FROM download_tasks WHERE id = ?', id).changes > 0;
  }
}
