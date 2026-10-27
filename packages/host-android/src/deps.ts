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

export interface DownloadToFileOptions {
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  /** Cumulative bytes received and total size when known. */
  readonly onProgress: (received: number, total: number | undefined) => void;
}

export interface PickFilesOptions {
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
}

export interface TorrentProgressEvent {
  readonly taskId: string;
  readonly status: 'resolving' | 'downloading' | 'completed' | 'failed';
  readonly progress?: number | undefined;
  readonly downloadedBytes: number;
  readonly totalBytes?: number | undefined;
  readonly speedBps: number;
  readonly peers?: number | undefined;
  readonly etaMs?: number | undefined;
  readonly error?: string | undefined;
  readonly files?: readonly {
    readonly index: number;
    readonly path: string;
    readonly sizeBytes: number;
    readonly downloadedBytes: number;
    readonly selected: boolean;
  }[] | undefined;
}

export interface AndroidTorrentEngine {
  start(
    request: {
      readonly taskId: string;
      readonly infoHash: string;
      readonly magnet?: string | undefined;
      readonly torrentUrl?: string | undefined;
      readonly targetDir: string;
      readonly maxPeers: number;
      readonly fileIndexes?: readonly number[] | undefined;
    },
    onProgress: (event: TorrentProgressEvent) => void,
  ): Promise<{ readonly stop: (reason: 'pause' | 'cancel', deleteFiles?: boolean) => Promise<void> }>;
  selectFiles?(taskId: string, fileIndexes: readonly number[]): Promise<TorrentProgressEvent>;
}

export interface CapacitorHostDeps {
  readonly fs: FsOps;
  /** Absolute root of `Directory.Data` (holds `subtitles/`, `manga/`, `downloads/`). */
  readonly dataRoot: string;
  /** `Capacitor.convertFileSrc` — turns a file path/URI into a WebView-loadable URL. */
  readonly convertFileSrc: (path: string) => string;
  /**
   * General `fetch` (production: patched by `CapacitorHttp`, so third-party
   * APIs work without CORS; responses are buffered by the native bridge).
   * Used for small JSON/HTML requests (Jimaku, Nyaa, mokuro.moe listings).
   */
  readonly fetch: typeof fetch;
  /**
   * The WebView's own `fetch` (`window.CapacitorWebFetch` when CapacitorHttp
   * is enabled): real response streaming + `AbortSignal`. Used for Gemini so
   * follow-up streaming and cancellation work (Google APIs allow CORS).
   */
  readonly webFetch: typeof fetch;
  /**
   * Stream a local file without materialising it (production: WebView fetch
   * of `convertFileSrc(path)`); avoids `Filesystem.readFile`'s whole-file
   * base64 copy for large archives.
   */
  readonly readFileStream: (path: string) => Promise<ReadableStream<Uint8Array>>;
  /**
   * Optional native download straight to disk with progress
   * (`Filesystem.downloadFile`). When absent, downloads stream through
   * `fetch` and are appended in ~1 MiB chunks.
   */
  readonly downloadToFile?: (url: string, path: string, options: DownloadToFileOptions) => Promise<void>;
  /**
   * Optional built-in Android BitTorrent engine (`KotoriTorrentPlugin`).
   * When absent, torrent tasks fall back to handing the magnet to `openExternal`.
   */
  readonly torrent?: AndroidTorrentEngine;
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
