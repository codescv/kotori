/**
 * Production dependencies for the Capacitor host (only the ones not
 * overridden are created, so tests never touch the native bridge).
 *
 * Directory / file pickers — DECISION:
 * `@capacitor/filesystem` 8.x has no directory picker (no `pickDirectory`
 * API), so pickers go through the community plugin
 * `@capawesome/capacitor-file-picker` (plugin name `FilePicker`), looked up
 * at runtime with `registerPlugin('FilePicker')` — no compile-time
 * dependency, so `@kotori/host-android` builds and tests without it. It is
 * added to the Android project at Gradle/integration time
 * (`pnpm add @capawesome/capacitor-file-picker && cap sync`).
 *  - `pickDirectory()` → `FilePicker.pickDirectory()` → `{ path }`. When the
 *    plugin is missing the call rejects `unsupported` with install guidance.
 *  - `pickFiles()` → `FilePicker.pickFiles({ types })` → `files[].path`;
 *    without the plugin it falls back to an HTML `<input type="file">` and
 *    copies the chosen files into `Directory.Data/imports/` so the returned
 *    paths are readable by `@capacitor/filesystem`.
 * Known integration risk: if the picker yields a SAF `content://` tree URI
 * that `Filesystem.readdir` cannot enumerate, library scanning of that tree
 * fails with an `io` error; the plugin's resolved file path is preferred.
 *
 * `openExternal` (magnets / external links): on native, assigning
 * `window.location.href` to a non-app URL is intercepted by Capacitor's
 * `BridgeWebViewClient` and launched as an `ACTION_VIEW` intent (e.g. an
 * installed BitTorrent app for `magnet:`), leaving the WebView in place. On
 * the web platform it uses `window.open`.
 */
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { AppIconId } from '@kotori/core';
import { KotoriError } from './adapters/core';
import type {
  AndroidTorrentEngine,
  CapacitorHostDeps,
  DownloadToFileOptions,
  FsOps,
  PickFilesOptions,
  TorrentProgressEvent,
} from './deps';
import { bytesToStream } from './storage/unzip-stream';
import { dirname, isWithin, joinPath, safeFileName } from './paths';
import { createCapacitorFs } from './storage/files';

interface PickedFile {
  readonly name: string;
  readonly path?: string;
  readonly mimeType: string;
  readonly size: number;
}

interface FilePickerPlugin {
  pickDirectory(): Promise<{ path: string }>;
  pickFiles(options?: { types?: string[]; limit?: number; readData?: boolean }): Promise<{ files: PickedFile[] }>;
}

interface KotoriTorrentNativePlugin {
  openExternal(options: { url: string }): Promise<void>;
  setAppIcon(options: { iconId: AppIconId }): Promise<{ iconId: AppIconId; changed: boolean }>;
  startTorrent(options: {
    taskId: string;
    infoHash: string;
    magnet?: string;
    torrentUrl?: string;
    targetDir: string;
    maxPeers: number;
    fileIndexes?: number[];
  }): Promise<void>;
  pauseTorrent(options: { taskId: string }): Promise<void>;
  cancelTorrent(options: { taskId: string; deleteFiles: boolean }): Promise<void>;
  selectFiles(options: { taskId: string; fileIndexes: number[] }): Promise<TorrentProgressEvent>;
  addListener(
    eventName: 'torrentProgress',
    listenerFunc: (event: TorrentProgressEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const FilePicker = registerPlugin<FilePickerPlugin>('FilePicker');
const KotoriTorrent = registerPlugin<KotoriTorrentNativePlugin>('KotoriTorrent');

function createNativeTorrentEngine(): AndroidTorrentEngine {
  return {
    async start(request, onProgress) {
      const listener = await KotoriTorrent.addListener('torrentProgress', (event) => {
        if (event.taskId === request.taskId) onProgress(event);
      });
      try {
        await KotoriTorrent.startTorrent({
          taskId: request.taskId,
          infoHash: request.infoHash,
          ...(request.magnet ? { magnet: request.magnet } : {}),
          ...(request.torrentUrl ? { torrentUrl: request.torrentUrl } : {}),
          targetDir: request.targetDir,
          maxPeers: request.maxPeers,
          ...(request.fileIndexes ? { fileIndexes: [...request.fileIndexes] } : {}),
        });
      } catch (error) {
        await listener.remove();
        throw error;
      }
      return {
        async stop(reason, deleteFiles = false) {
          await listener.remove();
          if (reason === 'pause') {
            await KotoriTorrent.pauseTorrent({ taskId: request.taskId }).catch(() => undefined);
          } else {
            await KotoriTorrent.cancelTorrent({ taskId: request.taskId, deleteFiles }).catch(() => undefined);
          }
        },
      };
    },
    async selectFiles(taskId, fileIndexes) {
      return KotoriTorrent.selectFiles({ taskId, fileIndexes: [...fileIndexes] });
    },
  };
}

/** The un-patched WebView fetch (`CapacitorHttp` keeps the original as `CapacitorWebFetch`). */
function webViewFetch(): typeof fetch {
  const original = (globalThis as { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch;
  return original ? (input, init) => original(input, init) : (input, init) => globalThis.fetch(input, init);
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.ass': 'text/x-ssa',
  '.ssa': 'text/x-ssa',
  '.zip': 'application/zip',
  '.cbz': 'application/vnd.comicbook+zip',
  '.mokuro': 'application/json',
  '.json': 'application/json',
};

function isCancel(error: unknown): boolean {
  return error instanceof Error && /cancel/i.test(error.message);
}

function isUnimplemented(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'UNIMPLEMENTED' || code === 'UNAVAILABLE' || (error instanceof Error && /not implemented|unimplemented/i.test(error.message));
}

/** HTML `<input type=file>` fallback; copies picks into `importsDir`. */
function pickWithInput(fs: FsOps, importsDir: string, options: PickFilesOptions | undefined): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options?.multiple ?? false;
    if (options?.accept !== undefined) input.accept = options.accept.join(',');
    input.addEventListener('cancel', () => resolve([]));
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      Promise.all(
        files.map(async (file) => {
          const path = joinPath(importsDir, `${Date.now().toString(36)}-${safeFileName(file.name)}`);
          await fs.writeFile(path, new Uint8Array(await file.arrayBuffer()));
          return path;
        }),
      ).then(resolve, reject);
    });
    input.click();
  });
}

/**
 * Convert a local path/URI through `Capacitor.convertFileSrc` and percent-encode
 * `#` and `?` in the resulting `/_capacitor_file_...` path so filenames like
 * `01_#カバー.jpg` or `#Zombie Sagashitemasu` are not truncated as URL fragments.
 */
function safeConvertFileSrc(path: string): string {
  const converted = Capacitor.convertFileSrc(path);
  const marker = '/_capacitor_file_';
  const idx = converted.indexOf(marker);
  if (idx < 0) return converted;
  const prefix = converted.slice(0, idx + marker.length);
  const rest = converted.slice(idx + marker.length).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return prefix + rest;
}

/**
 * Native download via `Filesystem.downloadFile` (streams to disk on the Java
 * side, no base64 round-trip). Deprecated upstream in favour of
 * `@capacitor/file-transfer` but still shipped in Filesystem 8; callers fall
 * back to streaming `fetch` when it is unimplemented or fails.
 *
 * IMPORTANT Android quirk in `@capacitor/filesystem` 8.x (`LegacyFilesystemImplementation.kt`):
 * 1. Omitting `directory` defaults to `Environment.DIRECTORY_DOWNLOADS` (`"Download"`),
 *    which `getDirectory()` does not recognise and returns `null` (`NullPointerException`).
 * 2. `recursive: true` is ignored by `LegacyFilesystemImplementation`, so the parent
 *    directory must be created beforehand with `fs.mkdir(dirname(path))`.
 * 3. When `directory: Directory.Data` is supplied, `path` must be relative to `dataRoot`.
 */
async function nativeDownload(fs: FsOps, dataRoot: string, url: string, path: string, options: DownloadToFileOptions): Promise<void> {
  const root = dataRoot.replace(/\/+$/, '');
  if (!isWithin(path, root)) {
    throw new KotoriError('unsupported', 'nativeDownload only supports paths within Directory.Data');
  }
  const relPath = path.slice(root.length).replace(/^\/+/, '');
  if (relPath === '') {
    throw new KotoriError('invalid-argument', 'nativeDownload target path cannot be root');
  }
  await fs.mkdir(dirname(path));
  const listener = await Filesystem.addListener('progress', (status) => {
    if (status.url === url) options.onProgress(status.bytes, status.contentLength > 0 ? status.contentLength : undefined);
  });
  try {
    if (options.signal.aborted) throw new KotoriError('cancelled', 'download aborted');
    const aborted = new Promise<never>((_, reject) =>
      options.signal.addEventListener('abort', () => reject(new KotoriError('cancelled', 'download aborted')), { once: true }),
    );
    const download = Filesystem.downloadFile({
      url,
      path: relPath,
      directory: Directory.Data,
      progress: true,
      recursive: true,
      ...(options.headers ? { headers: { ...options.headers } } : {}),
    });
    try {
      await Promise.race([download, aborted]);
    } catch (error) {
      if (options.signal.aborted) void download.then(() => fs.remove(path), () => undefined);
      throw error;
    }
  } finally {
    await listener.remove();
  }
}

/** Fill every dependency not supplied in `overrides`. */
export async function resolveDeps(overrides: Partial<CapacitorHostDeps>): Promise<CapacitorHostDeps> {
  const fs = overrides.fs ?? createCapacitorFs();
  const dataRoot = overrides.dataRoot ?? (await Filesystem.getUri({ directory: Directory.Data, path: '' })).uri;
  const importsDir = joinPath(dataRoot, 'imports');
  let version = overrides.version;
  if (version === undefined) {
    try {
      version = (await App.getInfo()).version;
    } catch {
      version = '0.1.16';
    }
  }
  return {
    fs,
    dataRoot,
    convertFileSrc: overrides.convertFileSrc ?? safeConvertFileSrc,
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    webFetch: overrides.webFetch ?? overrides.fetch ?? webViewFetch(),
    readFileStream:
      overrides.readFileStream ??
      (overrides.fs
        ? // Injected filesystem (tests): chunk its bytes.
          async (path) => bytesToStream(await fs.readFile(path))
        : async (path) => {
            const res = await webViewFetch()(safeConvertFileSrc(path));
            if (!res.ok || !res.body) throw new KotoriError('io', `cannot read ${path} (HTTP ${res.status})`);
            return res.body;
          }),
    ...(overrides.downloadToFile
      ? { downloadToFile: overrides.downloadToFile }
      : !overrides.fs && Capacitor.isNativePlatform()
        ? { downloadToFile: (url: string, path: string, options: DownloadToFileOptions) => nativeDownload(fs, dataRoot, url, path, options) }
        : {}),
    ...(overrides.torrent
      ? { torrent: overrides.torrent }
      : !overrides.fs && Capacitor.isNativePlatform()
        ? { torrent: createNativeTorrentEngine() }
        : {}),
    ...(overrides.setAppIcon
      ? { setAppIcon: overrides.setAppIcon }
      : !overrides.fs && Capacitor.isNativePlatform()
        ? {
            setAppIcon: async (iconId: AppIconId) => {
              await KotoriTorrent.setAppIcon({ iconId });
            },
          }
        : {}),
    openExternal:
      overrides.openExternal ??
      (async (url) => {
        if (Capacitor.isNativePlatform()) {
          try {
            await KotoriTorrent.openExternal({ url });
          } catch (error) {
            if (isUnimplemented(error)) window.location.href = url;
            else throw KotoriError.wrap(error, 'io');
          }
        } else {
          window.open(url, '_blank', 'noopener');
        }
      }),
    pickDirectory:
      overrides.pickDirectory ??
      (async () => {
        try {
          return (await FilePicker.pickDirectory()).path;
        } catch (error) {
          if (isCancel(error)) return undefined;
          if (isUnimplemented(error)) {
            throw new KotoriError('unsupported', 'Directory picker requires @capawesome/capacitor-file-picker in the Android project');
          }
          throw KotoriError.wrap(error, 'io');
        }
      }),
    pickFiles:
      overrides.pickFiles ??
      (async (options) => {
        try {
          const types = (options?.accept ?? []).map((a) => MIME_BY_EXT[a.toLowerCase()] ?? a).filter((t) => t.includes('/'));
          const result = await FilePicker.pickFiles({ ...(types.length > 0 ? { types } : {}), limit: options?.multiple === true ? 0 : 1 });
          return result.files.map((f) => f.path).filter((p): p is string => p !== undefined);
        } catch (error) {
          if (isCancel(error)) return [];
          if (isUnimplemented(error)) return pickWithInput(fs, importsDir, options);
          throw KotoriError.wrap(error, 'io');
        }
      }),
    idbFactory: overrides.idbFactory ?? globalThis.indexedDB,
    dbName: overrides.dbName ?? 'kotori',
    now: overrides.now ?? (() => Date.now()),
    progressDebounceMs: overrides.progressDebounceMs ?? 1000,
    downloadEventIntervalMs: overrides.downloadEventIntervalMs ?? 500,
    version,
  };
}
