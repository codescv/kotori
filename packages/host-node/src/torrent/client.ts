/**
 * `TorrentClient`: shared peer id (`-KT0100-…`), TCP listener for incoming
 * peers (routed by handshake info hash), optional DHT node, UDP tracker
 * socket, client-wide rate limits, and the torrent registry.
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { randomInt } from 'node:crypto';
import { DhtNode } from './dht';
import { normaliseInfoHash, parseMagnet, parseTorrentFile } from './metainfo';
import type { TorrentMeta } from './metainfo';
import { PeerConnection } from './peer';
import { TokenBucket } from './throttle';
import { Torrent } from './torrent';
import type { TorrentContext } from './torrent';
import type { PeerAddress } from './tracker-http';
import { UdpTrackerClient } from './tracker-udp';
import type { TorrentAddInput, TorrentAddOptions, TorrentClientOptions } from './types';

export const PEER_ID_PREFIX = '-KT0100-';

/** 20-byte peer id: `-KT0100-` + 12 random alphanumerics. */
export function generatePeerId(): Uint8Array {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let id = PEER_ID_PREFIX;
  while (id.length < 20) id += alphabet[randomInt(alphabet.length)];
  return new TextEncoder().encode(id);
}

/** Events: `'torrent'(Torrent)` after add, `'warning'(Error)`. */
export class TorrentClient extends EventEmitter {
  readonly peerId: Uint8Array;
  private readonly options: TorrentClientOptions;
  private readonly torrents = new Map<string, Torrent>();
  private readonly pendingIncoming = new Set<PeerConnection>();
  private readonly downloadBucket: TokenBucket;
  private readonly uploadBucket: TokenBucket;
  private readonly udp: UdpTrackerClient | undefined;
  private dht: DhtNode | undefined;
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private _port = 0;
  private destroyed = false;

  constructor(o: TorrentClientOptions) {
    super();
    this.options = o;
    this.peerId = generatePeerId();
    this.downloadBucket = new TokenBucket(o.downloadLimitBps);
    this.uploadBucket = new TokenBucket(o.uploadLimitBps);
    this.udp = o.trackers === false ? undefined : new UdpTrackerClient();
  }

  /** Bound TCP port (0 before `listen()`). */
  get port(): number {
    return this._port;
  }

  /** Starts the TCP listener (and DHT when enabled). Idempotent; resolves to the TCP port. */
  listen(): Promise<number> {
    if (this.destroyed) return Promise.reject(new Error('client destroyed'));
    if (!this.listening) {
      this.listening = new Promise<number>((resolve, reject) => {
        const server = createServer((socket) => this.onIncoming(socket));
        server.once('error', reject);
        server.listen(this.options.port ?? 0, () => {
          server.removeListener('error', reject);
          server.on('error', (err) => this.emit('warning', err));
          const addr = server.address();
          this._port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve(this._port);
        });
        this.server = server;
      }).then((port) => {
        if (this.options.dht !== false && !this.destroyed) this.startDht(port);
        return port;
      });
      this.listening.catch(() => {
        this.listening = undefined;
      });
    }
    return this.listening;
  }

  private startDht(port: number): void {
    const dht = new DhtNode({ port });
    dht.on('peer', (peer: PeerAddress, infoHash: string) => this.torrents.get(infoHash)?.addPeer(peer));
    dht.on('warning', (err: Error) => this.emit('warning', err));
    this.dht = dht;
    void dht.start();
  }

  private onIncoming(socket: Socket): void {
    if (this.destroyed) {
      socket.destroy();
      return;
    }
    const pc = new PeerConnection(socket, false);
    this.pendingIncoming.add(pc);
    pc.once('close', () => this.pendingIncoming.delete(pc));
    pc.once('handshake', (infoHashHex: string) => {
      this.pendingIncoming.delete(pc);
      const t = this.torrents.get(infoHashHex);
      if (!t || !t.acceptIncoming(pc)) pc.destroy();
    });
  }

  private context(): TorrentContext {
    return {
      peerId: this.peerId,
      dataDir: this.options.dataDir,
      port: () => this._port,
      dht: this.dht,
      udp: this.udp,
      trackersEnabled: this.options.trackers !== false,
      maxPeers: this.options.maxPeersPerTorrent ?? 50,
      downloadBucket: this.downloadBucket,
      uploadBucket: this.uploadBucket,
    };
  }

  /**
   * Adds a torrent. Resolves immediately (status `resolving`) for magnets /
   * bare info hashes; `.torrent` URLs are fetched first. Re-adding a known
   * info hash returns the existing torrent (with any new peers added).
   */
  async add(input: TorrentAddInput, opts: TorrentAddOptions): Promise<Torrent> {
    if (this.destroyed) throw new Error('client destroyed');
    await this.listen();

    let meta: TorrentMeta | undefined;
    let infoHash: string | undefined;
    let name: string | undefined;
    let trackers: readonly string[] = [];
    let peers: readonly PeerAddress[] = [];

    const fromMagnet = (uri: string): void => {
      const m = parseMagnet(uri);
      infoHash = m.infoHash;
      name = m.name;
      trackers = m.trackers;
      peers = m.peers;
    };

    if (input.torrentFile) {
      meta = parseTorrentFile(input.torrentFile);
    } else if (input.torrentUrl) {
      if (/^magnet:/i.test(input.torrentUrl)) {
        fromMagnet(input.torrentUrl);
      } else {
        const res = await fetch(input.torrentUrl, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`failed to fetch torrent (${res.status}): ${input.torrentUrl}`);
        meta = parseTorrentFile(new Uint8Array(await res.arrayBuffer()));
      }
    } else if (input.magnet) {
      fromMagnet(input.magnet);
    } else if (input.infoHash) {
      infoHash = normaliseInfoHash(input.infoHash);
      if (!infoHash) throw new Error(`invalid info hash: ${input.infoHash}`);
    } else {
      throw new Error('add: one of magnet, torrentFile, torrentUrl or infoHash is required');
    }
    const hash = meta?.infoHash ?? infoHash;
    if (!hash) throw new Error('could not determine info hash');
    if (this.destroyed) throw new Error('client destroyed');

    const existing = this.torrents.get(hash);
    if (existing) {
      for (const p of [...peers, ...(opts.peers ?? [])]) existing.addPeer(p);
      return existing;
    }

    const torrent = new Torrent(this.context(), { infoHash: hash, meta, name, trackers, peers, opts });
    this.torrents.set(hash, torrent);
    torrent.on('warning', (err: Error) => this.emit('warning', err));
    torrent.start();
    this.emit('torrent', torrent);
    return torrent;
  }

  get(infoHash: string): Torrent | undefined {
    return this.torrents.get(infoHash.toLowerCase());
  }

  list(): Torrent[] {
    return [...this.torrents.values()];
  }

  /** Stops and forgets a torrent; `deleteFiles` also removes payload files and the resume bitfield. */
  async remove(infoHash: string, opts: { deleteFiles?: boolean } = {}): Promise<void> {
    const key = infoHash.toLowerCase();
    const t = this.torrents.get(key);
    if (!t) return;
    this.torrents.delete(key);
    await t.destroy(opts);
  }

  /** Changes client-wide rate limits at runtime (unset/0 = unlimited). */
  setLimits(limits: { downloadLimitBps?: number; uploadLimitBps?: number }): void {
    if ('downloadLimitBps' in limits) this.downloadBucket.setRate(limits.downloadLimitBps);
    if ('uploadLimitBps' in limits) this.uploadBucket.setRate(limits.uploadLimitBps);
  }

  /** Stops every torrent, closes the listener, DHT and tracker socket. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const all = [...this.torrents.values()];
    this.torrents.clear();
    await Promise.all(all.map((t) => t.destroy().catch(() => undefined)));
    for (const pc of this.pendingIncoming) pc.destroy();
    this.pendingIncoming.clear();
    await this.listening?.catch(() => undefined);
    const server = this.server;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await this.dht?.destroy();
    this.udp?.destroy();
  }
}
