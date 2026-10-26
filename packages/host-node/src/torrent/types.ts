/**
 * Public types of the pure-TS BitTorrent engine (consumed by the downloads
 * manager). Kept structurally identical to the contract agreed with coder-2.
 */

export interface TorrentClientOptions {
  /** Directory for `.bitfield` resume files. */
  dataDir: string;
  /** TCP listen port (also the DHT UDP port). 0 = random. Default 0. */
  port?: number;
  /** Enable the mainline DHT. Default true; tests pass false. */
  dht?: boolean;
  /** Announce to trackers. Default true. */
  trackers?: boolean;
  /** Max connected peers per torrent. Default 50. */
  maxPeersPerTorrent?: number;
  /** Client-wide download limit in bytes/s (unset/0 = unlimited). */
  downloadLimitBps?: number;
  /** Client-wide upload limit in bytes/s (unset/0 = unlimited). */
  uploadLimitBps?: number;
}

export interface TorrentAddInput {
  magnet?: string;
  torrentFile?: Uint8Array;
  /** `.torrent` URL (fetched) — a `magnet:` URI here is accepted too. */
  torrentUrl?: string;
  /** Bare 40-hex / 32-base32 info hash (metadata fetched from peers). */
  infoHash?: string;
}

export interface TorrentAddOptions {
  downloadDir: string;
  /** Files to download (default: all). */
  fileIndexes?: readonly number[];
  /** Extra peers to connect to (e.g. a known seeder). */
  peers?: readonly { host: string; port: number }[];
  /** Keep serving after the selected files completed (status `seeding`); default false (`completed`). */
  seedAfterComplete?: boolean;
}

export type TorrentStatus = 'resolving' | 'downloading' | 'paused' | 'seeding' | 'completed' | 'error';

export interface TorrentFileInfo {
  index: number;
  /** Forward-slash, relative to downloadDir, incl. torrent name dir for multi-file. */
  path: string;
  length: number;
  downloaded: number;
  selected: boolean;
}

export interface TorrentStats {
  downloadedBytes: number;
  totalBytes: number;
  /** 0..1 over selected files. */
  progress: number;
  speedBps: number;
  uploadSpeedBps: number;
  peers: number;
  seeds: number;
  etaMs?: number;
}
