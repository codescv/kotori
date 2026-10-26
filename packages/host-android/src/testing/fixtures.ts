/** Node-only fixture loader for tests (copies `test-fixtures/` into a `MemoryFs`). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FsOps } from '../deps';
import { joinPath } from '../paths';

export const FIXTURES_DIR = fileURLToPath(new URL('../../test-fixtures/', import.meta.url));

/** Raw bytes of a fixture file. */
export function fixtureBytes(relative: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, relative))).slice();
}

/** Text of a fixture file. */
export function fixtureText(relative: string): string {
  return readFileSync(join(FIXTURES_DIR, relative), 'utf-8');
}

/** Recursively copy `test-fixtures/{relative}` to `target` in `fs`. */
export async function loadFixtureDir(fs: FsOps, relative: string, target: string): Promise<void> {
  const src = join(FIXTURES_DIR, relative);
  await fs.mkdir(target);
  for (const name of readdirSync(src)) {
    const full = join(src, name);
    if (statSync(full).isDirectory()) await loadFixtureDir(fs, join(relative, name), joinPath(target, name));
    else await fs.writeFile(joinPath(target, name), new Uint8Array(readFileSync(full)));
  }
}
