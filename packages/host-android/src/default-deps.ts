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
import { KotoriError } from './adapters/core';
import type { CapacitorHostDeps, FsOps, PickFilesOptions } from './deps';
import { joinPath, safeFileName } from './paths';
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

const FilePicker = registerPlugin<FilePickerPlugin>('FilePicker');

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
      version = '0.1.0';
    }
  }
  return {
    fs,
    dataRoot,
    convertFileSrc: overrides.convertFileSrc ?? ((path) => Capacitor.convertFileSrc(path)),
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    openExternal:
      overrides.openExternal ??
      (async (url) => {
        if (Capacitor.isNativePlatform()) window.location.href = url;
        else window.open(url, '_blank', 'noopener');
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
