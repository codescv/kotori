/**
 * Injectable dependencies of the Capacitor host. Production values come from
 * `createDefaultDeps()` (`./default-deps`); tests pass fakes
 * (`fake-indexeddb`, in-memory `FsOps`, fake `fetch`, controllable clock).
 */

/** One directory entry / stat result. `path` is absolute (path or URI). */
export interface FsEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * Minimal filesystem surface the host needs. All paths are absolute
 * (`file:///…` URIs or `/…` paths). Production: `@capacitor/filesystem`
 * (`storage/files.ts`); tests: `createMemoryFs()`.
 */
export interface FsOps {
  readFile(path: string): Promise<Uint8Array>;
  /** Creates parent directories as needed; replaces existing content. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Appends (creates the file when missing). */
  appendFile(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<readonly FsEntry[]>;
  /** `undefined` when the path does not exist. */
  stat(path: string): Promise<FsEntry | undefined>;
  /** Recursive; no-op when it already exists. */
  mkdir(path: string): Promise<void>;
  /** File or directory (recursive); no-op when missing. */
  remove(path: string): Promise<void>;
}

export interface PickFilesOptions {
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
}

export interface CapacitorHostDeps {
  readonly fs: FsOps;
  /** Absolute root of `Directory.Data` (holds `subtitles/`, `manga/`, `downloads/`). */
  readonly dataRoot: string;
  /** `Capacitor.convertFileSrc` — turns a file path/URI into a WebView-loadable URL. */
  readonly convertFileSrc: (path: string) => string;
  readonly fetch: typeof fetch;
  /** Open URL / magnet in an external app (Android intent). */
  readonly openExternal: (url: string) => Promise<void>;
  /** Native directory picker; `undefined` when cancelled. */
  readonly pickDirectory: () => Promise<string | undefined>;
  /** Native file picker; `[]` when cancelled. Returned paths must be readable by `fs`. */
  readonly pickFiles: (options?: PickFilesOptions) => Promise<readonly string[]>;
  readonly idbFactory: IDBFactory;
  readonly dbName: string;
  readonly now: () => number;
  /** Progress persistence debounce (ms). */
  readonly progressDebounceMs: number;
  /** Minimum interval between `download-updated` progress events per task (ms). */
  readonly downloadEventIntervalMs: number;
  readonly version: string;
}
