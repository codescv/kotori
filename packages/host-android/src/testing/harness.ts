/**
 * Test helpers: in-memory `FsOps` and a host factory over `fake-indexeddb`.
 * Not exported from the package entry point.
 */
import { IDBFactory } from 'fake-indexeddb';
import type { PlatformHost } from '@kotori/core';
import { createCapacitorPlatformHost } from '../capacitor-host';
import type { CapacitorHostDeps, FsEntry, FsOps } from '../deps';

type Node = { kind: 'file'; data: Uint8Array; mtimeMs: number } | { kind: 'dir'; mtimeMs: number };

export interface MemoryFs extends FsOps {
  /** Raw node table (for assertions). */
  readonly nodes: Map<string, Node>;
  /** Count of `writeFile` + `appendFile` calls per path prefix. */
  writes(prefix: string): number;
  readTextSync(path: string): string;
}

function norm(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function parentOf(path: string): string | undefined {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return undefined;
  const parent = path.slice(0, idx);
  return /:\/?\/?$/.test(parent) ? undefined : parent;
}

/** In-memory filesystem honouring the `FsOps` contract. */
export function createMemoryFs(now: () => number = () => Date.now()): MemoryFs {
  const nodes = new Map<string, Node>();
  const writeLog: string[] = [];
  const ensureDir = (path: string): void => {
    const p = norm(path);
    const existing = nodes.get(p);
    if (existing?.kind === 'file') throw new Error(`ENOTDIR: ${p}`);
    if (existing) return;
    const parent = parentOf(p);
    if (parent !== undefined) ensureDir(parent);
    nodes.set(p, { kind: 'dir', mtimeMs: now() });
  };
  const entry = (path: string, node: Node): FsEntry => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind: node.kind,
    sizeBytes: node.kind === 'file' ? node.data.length : 0,
    mtimeMs: node.mtimeMs,
  });
  const fs: MemoryFs = {
    nodes,
    writes: (prefix) => writeLog.filter((p) => p.startsWith(prefix)).length,
    readTextSync(path) {
      const node = nodes.get(norm(path));
      if (node?.kind !== 'file') throw new Error(`ENOENT: ${path}`);
      return new TextDecoder().decode(node.data);
    },
    async readFile(path) {
      const node = nodes.get(norm(path));
      if (node?.kind !== 'file') throw new Error(`ENOENT: ${path}`);
      return node.data.slice();
    },
    async writeFile(path, data) {
      const p = norm(path);
      const parent = parentOf(p);
      if (parent !== undefined) ensureDir(parent);
      nodes.set(p, { kind: 'file', data: data.slice(), mtimeMs: now() });
      writeLog.push(p);
    },
    async appendFile(path, data) {
      const p = norm(path);
      const node = nodes.get(p);
      const prev = node?.kind === 'file' ? node.data : new Uint8Array(0);
      const next = new Uint8Array(prev.length + data.length);
      next.set(prev);
      next.set(data, prev.length);
      const parent = parentOf(p);
      if (parent !== undefined) ensureDir(parent);
      nodes.set(p, { kind: 'file', data: next, mtimeMs: now() });
      writeLog.push(p);
    },
    async readdir(path) {
      const p = norm(path);
      if (nodes.get(p)?.kind !== 'dir') throw new Error(`ENOTDIR: ${path}`);
      const out: FsEntry[] = [];
      for (const [key, node] of nodes) {
        if (key.startsWith(`${p}/`) && !key.slice(p.length + 1).includes('/')) out.push(entry(key, node));
      }
      return out;
    },
    async stat(path) {
      const p = norm(path);
      const node = nodes.get(p);
      return node ? entry(p, node) : undefined;
    },
    async mkdir(path) {
      ensureDir(path);
    },
    async remove(path) {
      const p = norm(path);
      for (const key of [...nodes.keys()]) if (key === p || key.startsWith(`${p}/`)) nodes.delete(key);
    },
  };
  return fs;
}

export const DATA_ROOT = 'file:///data/user/0/dev.kotori.app/files';

export interface TestHost {
  readonly host: PlatformHost;
  readonly fs: MemoryFs;
  readonly idbFactory: IDBFactory;
  readonly deps: Partial<CapacitorHostDeps>;
  readonly clock: { now: number };
}

/** Host over fresh fake IndexedDB + memory fs; `convertFileSrc` maps to `https://localhost/_capacitor_file_…`. */
export async function createTestHost(overrides: Partial<CapacitorHostDeps> = {}, shared?: Pick<TestHost, 'fs' | 'idbFactory' | 'clock'>): Promise<TestHost> {
  const clock = shared?.clock ?? { now: 1_700_000_000_000 };
  const fs = shared?.fs ?? createMemoryFs(() => clock.now);
  const idbFactory = shared?.idbFactory ?? new IDBFactory();
  const deps: Partial<CapacitorHostDeps> = {
    fs,
    dataRoot: DATA_ROOT,
    convertFileSrc: (path) => `https://localhost/_capacitor_file_${path.replace(/^file:\/\//, '')}`,
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    openExternal: () => Promise.resolve(),
    pickDirectory: () => Promise.resolve(undefined),
    pickFiles: () => Promise.resolve([]),
    idbFactory,
    dbName: 'kotori-test',
    now: () => clock.now,
    progressDebounceMs: 0,
    downloadEventIntervalMs: 500,
    version: 'test',
    ...overrides,
  };
  const host = await createCapacitorPlatformHost(deps);
  return { host, fs, idbFactory, deps, clock };
}

/** Minimal valid PNG header (IHDR only) with the given size — enough for `readImageSize`. */
export function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}
