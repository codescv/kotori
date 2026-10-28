/**
 * Server-side `DictionaryHost`: Yomitan v3 import (preset / URL / local file /
 * uploaded bytes) with `dict-import-progress` events, plus render-time
 * enrichment and click-to-lookup over `DictionaryRepository`.
 *
 * URL / preset archives are first streamed to `<dataDir>/cache/` (so a failed
 * streaming decode can fall back to an in-memory pass without re-downloading)
 * and deleted after import.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { KotoriError, findDictPreset } from '@kotori/core';
import type { DictionaryHost, DictionaryImportSource, DictionaryInfo, HostEvent } from '@kotori/core';
import type { DictImportOptions, DictImportProgress, DictionaryRepository } from '../../db/repositories/dictionaries';

export interface DictServiceDeps {
  readonly repo: DictionaryRepository;
  readonly emit: (event: HostEvent) => void;
  readonly fetch: typeof fetch;
  readonly dataDir: string;
  readonly now?: () => number;
}

/** Minimum interval between `downloading` progress events (ms). */
const DOWNLOAD_EVENT_INTERVAL_MS = 500;

function newImportId(now: number): string {
  return `dict_${now.toString(36)}${Math.floor(Math.random() * 0xffffffffff).toString(16).padStart(10, '0')}`;
}

function titleFromFileName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = basename(name.replace(/\\/g, '/')).replace(/\.zip$/i, '').trim();
  return base === '' ? undefined : base;
}

function titleFromUrl(url: string): string | undefined {
  try {
    return titleFromFileName(decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''));
  } catch {
    return undefined;
  }
}

export function createDictService(deps: DictServiceDeps): DictionaryHost {
  const { repo } = deps;
  const now = deps.now ?? (() => Date.now());
  const cacheDir = join(deps.dataDir, 'cache');

  const progress = (p: DictImportProgress): void => {
    deps.emit({ type: 'dict-import-progress', dictId: p.dictId, title: p.title, phase: p.phase, processedRows: p.processedRows, ...(p.error !== undefined ? { error: p.error } : {}) });
  };

  /** Stream `url` to `dest`, emitting throttled `downloading` events. */
  async function download(url: string, dest: string, dictId: string, title: string): Promise<void> {
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: { 'user-agent': 'Kotori/0.1 (+https://github.com/kotori)' }, redirect: 'follow' });
    } catch (error) {
      throw new KotoriError('network', `Cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!res.ok) throw new KotoriError('network', `HTTP ${res.status} downloading ${url}`, { details: { status: res.status } });
    deps.emit({ type: 'dict-import-progress', dictId, title, phase: 'downloading', processedRows: 0 });
    await mkdir(cacheDir, { recursive: true });
    if (!res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      await pipeline(Readable.from([bytes]), createWriteStream(dest));
      return;
    }
    let last = 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', () => {
      const t = Date.now();
      if (t - last < DOWNLOAD_EVENT_INTERVAL_MS) return;
      last = t;
      deps.emit({ type: 'dict-import-progress', dictId, title, phase: 'downloading', processedRows: 0 });
    });
    await pipeline(body, createWriteStream(dest));
  }

  async function importFile(path: string, options: DictImportOptions): Promise<DictionaryInfo> {
    let size: number;
    try {
      const s = await stat(path);
      if (!s.isFile()) throw new Error('not a file');
      size = s.size;
    } catch {
      throw new KotoriError('not-found', `Dictionary file not found: ${path}`);
    }
    if (size === 0) throw new KotoriError('invalid-argument', `Dictionary file is empty: ${path}`);
    return repo.importZipStream(createReadStream(path, { highWaterMark: 1 << 20 }), { ...options, readAll: async () => new Uint8Array(await readFile(path)) }, progress);
  }

  return {
    list: async () => repo.list(),

    async importZip(source: DictionaryImportSource): Promise<DictionaryInfo> {
      if (typeof source !== 'object' || source === null) throw new KotoriError('invalid-argument', 'import source is required');
      const dictId = newImportId(now());
      const preset = source.presetId !== undefined ? findDictPreset(source.presetId) : undefined;
      if (source.presetId !== undefined && !preset) throw new KotoriError('invalid-argument', `Unknown dictionary preset: ${source.presetId}`, { details: { field: 'presetId' } });

      const attribution = source.attribution ?? preset?.attribution;
      const indexUrl = source.indexUrl ?? preset?.indexUrl;
      const base: DictImportOptions = {
        dictId,
        ...(attribution !== undefined ? { attribution } : {}),
        ...(indexUrl !== undefined ? { indexUrl } : {}),
      };

      if (source.bytes !== undefined) {
        if (!(source.bytes instanceof Uint8Array) || source.bytes.length === 0) throw new KotoriError('invalid-argument', 'bytes must be a non-empty Uint8Array', { details: { field: 'bytes' } });
        const fallbackTitle = titleFromFileName(source.fileName) ?? preset?.title;
        return repo.importZipStream(source.bytes, { ...base, ...(fallbackTitle ? { fallbackTitle } : {}), now: now() }, progress);
      }

      if (source.filePath !== undefined) {
        if (!isAbsolute(source.filePath)) throw new KotoriError('invalid-argument', 'filePath must be absolute', { details: { field: 'filePath' } });
        const fallbackTitle = titleFromFileName(source.fileName ?? source.filePath) ?? preset?.title;
        return importFile(source.filePath, { ...base, ...(fallbackTitle ? { fallbackTitle } : {}), now: now() });
      }

      const url = source.url ?? preset?.downloadUrl;
      if (url === undefined) throw new KotoriError('invalid-argument', 'One of presetId, url, filePath or bytes is required');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new KotoriError('invalid-argument', `Invalid dictionary URL: ${url}`, { details: { field: 'url' } });
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new KotoriError('invalid-argument', 'Dictionary URL must be http(s)', { details: { field: 'url' } });
      const title = preset?.title ?? titleFromFileName(source.fileName) ?? titleFromUrl(url) ?? 'Dictionary';
      const tmp = join(cacheDir, `${dictId}.zip`);
      let downloaded = false;
      try {
        await download(url, tmp, dictId, title);
        downloaded = true;
        return await importFile(tmp, { ...base, fallbackTitle: title, sourceUrl: url, now: now() });
      } catch (error) {
        // Download failures never reached the repository (which reports its own failures).
        if (!downloaded) deps.emit({ type: 'dict-import-progress', dictId, title, phase: 'failed', processedRows: 0, error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    },

    update: async (id, patch) => repo.update(id, patch ?? {}),
    remove: async (id) => repo.remove(id),
    enrichVocab: (vocab) => repo.enrichVocab(Array.isArray(vocab) ? vocab : []),
    lookupPrefix: (text, maxLength) => repo.lookupPrefix(typeof text === 'string' ? text : '', maxLength ?? 16),
  };
}
