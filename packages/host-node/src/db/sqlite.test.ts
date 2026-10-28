import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, openDatabase, transaction, type Database, type Migration } from './sqlite';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kotori-sqlite-test-'));
  tmpDirs.push(dir);
  return dir;
}

function track(db: Database): Database {
  dbs.push(db);
  return db;
}

function scalar(db: Database, sql: string): unknown {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

function tableNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_TABLES = [
  'anime_episodes',
  'anime_series',
  'dict_meta',
  'dict_terms',
  'dictionaries',
  'download_tasks',
  'explanations',
  'follow_up_threads',
  'manga_pages',
  'manga_progress',
  'manga_volumes',
  'playback_progress',
  'schema_migrations',
  'settings',
  'subtitle_tracks',
];

describe('loadMigrations', () => {
  it('loads the bundled migrations in version order', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]).toMatchObject({ version: 1, name: 'init' });
    expect(migrations[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS anime_series');
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it('sorts numerically and ignores files that are not NNN_name.sql', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '10_ten.sql'), 'SELECT 10;');
    writeFileSync(join(dir, '2_two.sql'), 'SELECT 2;');
    writeFileSync(join(dir, '001_one.sql'), 'SELECT 1;');
    writeFileSync(join(dir, 'README.md'), '# nope');
    writeFileSync(join(dir, 'x_bad.sql'), 'SELECT 0;');
    writeFileSync(join(dir, '003_three.sql.bak'), 'SELECT 3;');
    const migrations = loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.name])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [10, 'ten'],
    ]);
    expect(migrations[2]?.sql).toBe('SELECT 10;');
  });
});

describe('openDatabase (:memory:)', () => {
  it('creates every schema table, records all bundled migrations and enables foreign keys', () => {
    const db = track(openDatabase(':memory:'));
    expect(tableNames(db)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual([
      { version: 1, name: 'init' },
      { version: 2, name: 'download_auto_import' },
      { version: 3, name: 'dictionaries' },
    ]);
    expect(scalar(db, 'PRAGMA foreign_keys')).toBe(1);
    expect(scalar(db, 'PRAGMA busy_timeout')).toBe(5000);
    // In-memory databases cannot use WAL; the wrapper must not try.
    expect(scalar(db, 'PRAGMA journal_mode')).toBe('memory');
  });

  it('migrate() is idempotent on an already migrated database', () => {
    const db = track(openDatabase(':memory:'));
    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);
    expect(scalar(db, 'SELECT COUNT(*) FROM schema_migrations')).toBe(3);
  });
});

describe('openDatabase (file)', () => {
  it('creates missing parent directories and uses WAL mode', () => {
    const path = join(tempDir(), 'nested', 'deeper', 'kotori.db');
    const db = track(openDatabase(path));
    expect(existsSync(path)).toBe(true);
    expect(scalar(db, 'PRAGMA journal_mode')).toBe('wal');
    expect(scalar(db, 'PRAGMA foreign_keys')).toBe(1);
  });

  it('re-opening the same file keeps data and applies no migration twice', () => {
    const path = join(tempDir(), 'kotori.db');
    const first = track(openDatabase(path));
    first.prepare('INSERT INTO settings (key, json) VALUES (?, ?)').run('k', '{"a":1}');
    const appliedAt = scalar(first, 'SELECT applied_at FROM schema_migrations WHERE version = 1');
    first.close();

    const second = track(openDatabase(path));
    expect(scalar(second, 'SELECT COUNT(*) FROM schema_migrations')).toBe(3);
    expect(scalar(second, 'SELECT applied_at FROM schema_migrations WHERE version = 1')).toBe(appliedAt);
    expect(scalar(second, "SELECT json FROM settings WHERE key = 'k'")).toBe('{"a":1}');
    expect(scalar(second, 'PRAGMA journal_mode')).toBe('wal');
    expect(migrate(second)).toEqual([]);
  });

  it('two connections can be open on the same WAL file concurrently', () => {
    const path = join(tempDir(), 'kotori.db');
    const a = track(openDatabase(path));
    const b = track(openDatabase(path));
    a.prepare('INSERT INTO settings (key, json) VALUES (?, ?)').run('shared', '1');
    expect(scalar(b, "SELECT json FROM settings WHERE key = 'shared'")).toBe('1');
  });
});

describe('migrate', () => {
  it('applies only pending migrations and returns their versions', () => {
    const db = track(openDatabase(':memory:'));
    const extra: Migration[] = [
      { version: 1, name: 'init', sql: 'THIS WOULD FAIL IF RE-RUN' },
      { version: 100, name: 'extra', sql: 'CREATE TABLE extra_t (x INTEGER);' },
    ];
    expect(migrate(db, extra)).toEqual([100]);
    expect(tableNames(db)).toContain('extra_t');
    expect(migrate(db, extra)).toEqual([]);
  });

  it('rolls back a failing migration (no partial DDL, no version row) and stops', () => {
    const db = track(openDatabase(':memory:'));
    const migrations: Migration[] = [
      { version: 100, name: 'broken', sql: 'CREATE TABLE half_done (x INTEGER); INSERT INTO no_such_table VALUES (1);' },
      { version: 101, name: 'after', sql: 'CREATE TABLE after_t (x INTEGER);' },
    ];
    expect(() => migrate(db, migrations)).toThrow(/no_such_table/);
    expect(tableNames(db)).not.toContain('half_done');
    expect(tableNames(db)).not.toContain('after_t');
    expect(scalar(db, 'SELECT MAX(version) FROM schema_migrations')).toBe(3);
    // The connection is usable afterwards (no dangling transaction).
    expect(db.isTransaction).toBe(false);
    expect(migrate(db, [{ version: 100, name: 'fixed', sql: 'CREATE TABLE fixed_t (x INTEGER);' }])).toEqual([100]);
  });
});

describe('transaction', () => {
  it('commits and returns the callback result', () => {
    const db = track(openDatabase(':memory:'));
    const result = transaction(db, () => {
      db.prepare('INSERT INTO settings (key, json) VALUES (?, ?)').run('a', '1');
      return 42;
    });
    expect(result).toBe(42);
    expect(scalar(db, 'SELECT COUNT(*) FROM settings')).toBe(1);
  });

  it('rolls back and rethrows on error', () => {
    const db = track(openDatabase(':memory:'));
    const boom = new Error('boom');
    expect(() =>
      transaction(db, () => {
        db.prepare('INSERT INTO settings (key, json) VALUES (?, ?)').run('a', '1');
        throw boom;
      }),
    ).toThrow(boom);
    expect(scalar(db, 'SELECT COUNT(*) FROM settings')).toBe(0);
    expect(db.isTransaction).toBe(false);
  });
});
