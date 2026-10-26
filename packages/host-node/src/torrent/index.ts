/**
 * Pure-TS BitTorrent engine (ARCHITECTURE.md §5.4). Zero native addons, no
 * webtorrent: bencode + bittorrent-protocol + ut_metadata + bittorrent-dht
 * glued with node:net / node:dgram / node:crypto / node:fs.
 *
 * Files:
 * - metainfo.ts      .torrent parse/create, info hash, magnet (hex + base32)
 * - tracker-http.ts  HTTP announce (compact peers)
 * - tracker-udp.ts   BEP 15 UDP announce (connection-id cache, retries)
 * - dht.ts           bittorrent-dht wrapper
 * - peer.ts          Wire over node:net, handshake, ut_metadata
 * - piece-picker.ts  rarest-first + sequential bias + end-game
 * - piece-buffer.ts  block bookkeeping for in-flight pieces
 * - storage.ts       piece↔file mapping, verified writes, resume bitfield
 * - throttle.ts      token bucket + speed meter
 * - torrent.ts       Torrent state machine
 * - client.ts        TorrentClient
 */
export { TorrentClient, PEER_ID_PREFIX, generatePeerId } from './client';
export { Torrent } from './torrent';
export type {
  TorrentAddInput,
  TorrentAddOptions,
  TorrentClientOptions,
  TorrentFileInfo,
  TorrentStats,
  TorrentStatus,
} from './types';
export {
  createTorrentFile,
  encodeTorrentFile,
  infoDictFromMetadata,
  normaliseInfoHash,
  parseMagnet,
  parseTorrentFile,
} from './metainfo';
export type { CreateTorrentOptions, MagnetInfo, TorrentFileEntry, TorrentMeta } from './metainfo';
