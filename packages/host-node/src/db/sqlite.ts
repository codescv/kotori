/**
 * `node:sqlite` (`DatabaseSync`, built into Node ≥ 22.5 — no native addon)
 * wrapper: opens the database in WAL mode with foreign keys and applies the
 * SQL migrations in `./migrations` (copied next to `dist/server.mjs` by
 * `build.mjs`, so the same relative URL works from source and from the bundle).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Locate the migrations directory (source tree or bundle). */
function migrationsDir(): string {
  const candidates = [new URL('./migrations/', import.meta.url), new URL('./db/migrations/', import.meta.url)];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  throw new Error('[kotori:db] migrations directory not found');
}

/** Read `NNN_name.sql` files in version order. */
export function loadMigrations(dir: string = migrationsDir()): Migration[] {
  return readdirSync(dir)
    .map((file) => /^(\d+)_(.+)\.sql$/.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ version: Number(m[1]), name: m[2] ?? '', sql: readFileSync(`${dir}/${m[0]}`, 'utf8') }))
    .sort((a, b) => a.version - b.version);
}

/** Apply pending migrations inside a transaction each; returns versions applied. */
export function migrate(db: Database, migrations: readonly Migration[] = loadMigrations()): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
  const done: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
      db.exec('COMMIT');
      done.push(m.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return done;
}

/** Open (creating parent dirs) a Kotori database; `':memory:'` for tests. */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

let savepointCounter = 0;

/**
 * Run `fn` atomically (synchronous; node:sqlite is sync). Nested calls use
 * SAVEPOINTs so repositories can be transactional on their own and still
 * compose inside a service-level transaction.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) {
    const name = `kotori_sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
