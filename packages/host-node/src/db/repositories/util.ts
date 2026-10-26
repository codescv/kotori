/** Small helpers shared by repositories (row casting, optional fields). */
import type { Database } from '../sqlite';

export type Row = Record<string, unknown>;

export function all<T extends Row = Row>(db: Database, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function one<T extends Row = Row>(db: Database, sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Database, sql: string, ...params: Array<string | number | null>): { changes: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes) };
}

/** `null`/`undefined` → omitted key (for `exactOptionalPropertyTypes`). */
export function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function nullable<V>(value: V | undefined): V | null {
  return value === undefined ? null : value;
}

export function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

export function optNum(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : num(value);
}

export function optStr(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
