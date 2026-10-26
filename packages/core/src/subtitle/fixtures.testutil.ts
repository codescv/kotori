/**
 * Test-only fixture loader for `packages/core/test-fixtures/subtitle/`.
 * Not exported from the barrel. Uses `process.getBuiltinModule` so the package
 * keeps `types: []` (no `@types/node`) and stays free of `node:*` imports.
 */

/** Minimal slice of `node:fs` we need. */
interface FsLike {
  readFileSync(path: URL): Uint8Array;
}

/** Resolve `node:fs` lazily at test time. */
function fs(): FsLike {
  const proc = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process;
  return proc.getBuiltinModule('node:fs') as FsLike;
}

/** Raw bytes of a subtitle fixture. */
export function readFixtureBytes(name: string): Uint8Array {
  const url = new URL(`../../test-fixtures/subtitle/${name}`, (import.meta as unknown as { url: string }).url);
  return new Uint8Array(fs().readFileSync(url));
}

/** UTF-8 text of a subtitle fixture (CRLF preserved). */
export function readFixtureText(name: string): string {
  return new TextDecoder('utf-8').decode(readFixtureBytes(name));
}
