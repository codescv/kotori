/**
 * `@capacitor/filesystem` wrappers and the app-data directory layout.
 *
 * Every path handed to `FsOps` is absolute (a `file://` URI from
 * `Filesystem.getUri({ directory: Directory.Data })` or from a picker), so
 * the Filesystem calls omit `directory`. Binary data crosses the bridge as
 * base64 (the native plugin's only binary encoding); on the web platform the
 * plugin returns a `Blob`, which is handled too.
 *
 * App files live under `Directory.Data`:
 *   subtitles/{episodeId}/…   imported + Jimaku subtitle files
 *   manga/{volumeId}/…        extracted CBZ/ZIP pages; manga/moe/… mokuro.moe volumes
 *   downloads/…               generic HTTP downloads (and temporary archives)
 *   imports/…                 copies of files chosen with the HTML file-input fallback
 */
import { Filesystem } from '@capacitor/filesystem';
import type { FileInfo } from '@capacitor/filesystem';
import type { FsEntry, FsOps } from '../deps';
import { joinPath } from '../paths';

const CHUNK = 0x8000;

/** Uint8Array → base64 without blowing the call stack on large buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/** base64 → Uint8Array. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toEntry(info: FileInfo, fallbackPath: string): FsEntry {
  return {
    name: info.name,
    path: info.uri === '' ? fallbackPath : info.uri,
    kind: info.type === 'directory' ? 'dir' : 'file',
    sizeBytes: info.size,
    mtimeMs: info.mtime,
  };
}

/** Production `FsOps` over `@capacitor/filesystem`. */
export function createCapacitorFs(): FsOps {
  const stat = async (path: string): Promise<FsEntry | undefined> => {
    try {
      const info = await Filesystem.stat({ path });
      return toEntry({ ...info, name: info.name === '' ? (path.split('/').pop() ?? '') : info.name }, path);
    } catch {
      return undefined;
    }
  };
  return {
    async readFile(path) {
      const { data } = await Filesystem.readFile({ path });
      return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer());
    },
    async writeFile(path, data) {
      await Filesystem.writeFile({ path, data: bytesToBase64(data), recursive: true });
    },
    async appendFile(path, data) {
      if ((await stat(path)) === undefined) await Filesystem.writeFile({ path, data: bytesToBase64(data), recursive: true });
      else await Filesystem.appendFile({ path, data: bytesToBase64(data) });
    },
    async readdir(path) {
      const { files } = await Filesystem.readdir({ path });
      return files.map((f) => toEntry(f, joinPath(path, f.name)));
    },
    stat,
    async mkdir(path) {
      if ((await stat(path)) !== undefined) return;
      await Filesystem.mkdir({ path, recursive: true });
    },
    async remove(path) {
      const entry = await stat(path);
      if (entry === undefined) return;
      if (entry.kind === 'dir') await Filesystem.rmdir({ path, recursive: true });
      else await Filesystem.deleteFile({ path });
    },
  };
}

/** App-owned directories under `Directory.Data`. */
export interface AppDirs {
  readonly root: string;
  readonly subtitles: string;
  readonly manga: string;
  readonly downloads: string;
  readonly imports: string;
}

export function appDirs(dataRoot: string): AppDirs {
  return {
    root: dataRoot,
    subtitles: joinPath(dataRoot, 'subtitles'),
    manga: joinPath(dataRoot, 'manga'),
    downloads: joinPath(dataRoot, 'downloads'),
    imports: joinPath(dataRoot, 'imports'),
  };
}

/** Read a UTF-8 text file. */
export async function readText(fs: FsOps, path: string): Promise<string> {
  return new TextDecoder('utf-8').decode(await fs.readFile(path));
}
