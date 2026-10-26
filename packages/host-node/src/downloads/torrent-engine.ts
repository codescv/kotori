/**
 * The slice of the pure-TS BitTorrent client (`src/torrent/client.ts`) the
 * download manager depends on. Kept structural so the manager can be tested
 * with a fake engine and the real `TorrentClient` satisfies it as-is.
 */
export type TorrentEngineStatus = 'resolving' | 'downloading' | 'paused' | 'seeding' | 'completed' | 'error';

export interface TorrentEngineFile {
  readonly index: number;
  readonly path: string;
  readonly length: number;
  readonly downloaded: number;
  readonly selected: boolean;
}

export interface TorrentEngineStats {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly progress: number;
  readonly speedBps: number;
  readonly uploadSpeedBps: number;
  readonly peers: number;
  readonly seeds: number;
  readonly etaMs?: number;
}

export interface TorrentHandle {
  readonly infoHash: string;
  readonly name: string | undefined;
  readonly status: TorrentEngineStatus;
  readonly files: readonly TorrentEngineFile[];
  readonly error?: string;
  stats(): TorrentEngineStats;
  pause(): void;
  resume(): void;
  selectFiles(indexes: readonly number[]): void;
  on(event: 'metadata' | 'status' | 'progress' | 'done', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'metadata' | 'status' | 'progress' | 'done', listener: () => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

export interface TorrentEngineAddInput {
  magnet?: string;
  torrentFile?: Uint8Array;
  torrentUrl?: string;
  infoHash?: string;
}

export interface TorrentEngineAddOptions {
  downloadDir: string;
  fileIndexes?: readonly number[];
  peers?: readonly { host: string; port: number }[];
  seedAfterComplete?: boolean;
}

export interface TorrentEngine {
  add(input: TorrentEngineAddInput, options: TorrentEngineAddOptions): Promise<TorrentHandle>;
  get(infoHash: string): TorrentHandle | undefined;
  remove(infoHash: string, options?: { deleteFiles?: boolean }): Promise<void>;
  destroy(): Promise<void>;
}
