/** Server-side `DownloadsApi` (discovery searches + `DownloadManager` delegation) and `FilesApi`. */
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { KotoriError } from '@kotori/core';
import type { DirectoryEntry, DownloadsApi, FilesApi } from '@kotori/core';
import { buildNyaaRssUrl, createJimakuClient, parseMokuroMoeListing, parseNyaaRss, resolveMokuroCatalogUrl } from '@kotori/core';
import type { DownloadManager } from '../../downloads/manager';
import type { SettingsStore } from '../../settings/store';

export interface DownloadsServiceDeps {
  readonly settings: SettingsStore;
  readonly manager: () => DownloadManager;
  readonly fetch: typeof fetch;
}

async function fetchText(fetchFn: typeof fetch, url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { 'user-agent': 'Kotori/0.1 (+https://github.com/kotori)' } });
  } catch (error) {
    throw new KotoriError('network', `Cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new KotoriError('network', `HTTP ${res.status} from ${new URL(url).host}`, { details: { status: res.status } });
  return res.text();
}

export function createDownloadsService(deps: DownloadsServiceDeps): DownloadsApi {
  const jimaku = () => createJimakuClient({ fetch: deps.fetch, apiKey: deps.settings.get().anime.jimakuApiKey });
  return {
    async searchNyaa(query) {
      if (!query.query?.trim()) throw new KotoriError('invalid-argument', 'Search query is empty');
      const xml = await fetchText(deps.fetch, buildNyaaRssUrl(query, deps.settings.get().downloads.nyaaBaseUrl));
      return parseNyaaRss(xml);
    },
    searchJimaku: (query) => jimaku().searchEntries(query),
    listJimakuFiles: (entryId, episode) => jimaku().listFiles(entryId, episode),
    async browseMokuroCatalog(url) {
      const root = deps.settings.get().downloads.mokuroCatalogUrl;
      const rawTarget = url ?? root;
      if (!/^https?:\/\//i.test(rawTarget)) throw new KotoriError('invalid-argument', 'Catalog URL must be http(s)');
      const target = resolveMokuroCatalogUrl(rawTarget);
      return parseMokuroMoeListing(await fetchText(deps.fetch, target), target);
    },
    list: async () => deps.manager().list(),
    get: async (taskId) => deps.manager().get(taskId),
    start: (request) => deps.manager().start(request),
    pause: (taskId) => deps.manager().pause(taskId),
    resume: (taskId) => deps.manager().resume(taskId),
    cancel: (taskId) => deps.manager().cancel(taskId),
    remove: (taskId, deleteFiles) => deps.manager().remove(taskId, deleteFiles),
    selectFiles: (taskId, indexes) => deps.manager().selectFiles(taskId, indexes),
  };
}

export type Opener = (target: string) => Promise<void>;

/** Default OS opener: `open` (macOS) / `xdg-open` (Linux), detached. */
export const systemOpener: Opener = (target) =>
  new Promise((resolvePromise, reject) => {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (error) => reject(new KotoriError('unsupported', `Cannot open external handler: ${error.message}`)));
    child.on('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });

export interface NodeFilesApi extends FilesApi {
  listDirectory(path?: string): Promise<{ readonly path: string; readonly parent?: string; readonly entries: readonly DirectoryEntry[] }>;
  openExternal(url: string): Promise<void>;
}

export function createFilesService(deps: { opener?: Opener; home?: string } = {}): NodeFilesApi {
  const opener = deps.opener ?? systemOpener;
  return {
    async listDirectory(path) {
      const target = path === undefined || path === '' ? (deps.home ?? homedir()) : path;
      if (!isAbsolute(target)) throw new KotoriError('invalid-argument', 'Path must be absolute');
      const abs = resolve(target);
      let names: string[];
      try {
        const st = await stat(abs);
        if (!st.isDirectory()) throw new KotoriError('invalid-argument', `${abs} is not a directory`);
        names = await readdir(abs);
      } catch (error) {
        if (error instanceof KotoriError) throw error;
        throw new KotoriError('not-found', `Cannot read directory ${abs}`);
      }
      const entries: DirectoryEntry[] = [];
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const full = join(abs, name);
        try {
          const st = await stat(full);
          if (st.isDirectory()) entries.push({ name, path: full, kind: 'dir' });
          else if (st.isFile()) entries.push({ name, path: full, kind: 'file', sizeBytes: st.size });
        } catch {
          // broken symlink / permission denied: skip
        }
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
      const parent = dirname(abs);
      return parent === abs ? { path: abs, entries } : { path: abs, parent, entries };
    },
    async openExternal(url) {
      // Never hand local files / custom schemes to the OS opener (could execute downloaded content).
      if (!/^(https?:\/\/|magnet:\?)/i.test(url)) throw new KotoriError('invalid-argument', 'Only http(s) and magnet links can be opened externally');
      await opener(url);
    },
  };
}
