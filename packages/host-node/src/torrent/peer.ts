/**
 * One peer connection: a `bittorrent-protocol` Wire over a `node:net` socket,
 * with handshake validation, BEP 10 extended handshake + BEP 9 ut_metadata,
 * keep-alives and timeouts. Request scheduling lives in `torrent.ts`.
 */
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import Wire from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';
import { toHex } from './metainfo';

/** Max outstanding block requests per peer. */
export const MAX_INFLIGHT = 16;
export const CONNECT_TIMEOUT_MS = 10_000;
export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 30_000;

/** Opens a TCP connection with a timeout. */
export function connectSocket(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timeout ${host}:${port}`));
    }, timeoutMs);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

export interface StartParams {
  readonly infoHash: Uint8Array;
  readonly peerId: Uint8Array;
  /** Raw info dict when known (served over ut_metadata). */
  readonly metadata?: Uint8Array | undefined;
  readonly dht?: boolean;
}

/**
 * Events:
 * - `'handshake'(infoHashHex, peerIdHex)` — remote handshake received
 * - `'metadata'(Uint8Array)` — bencoded `{ info }` fetched via ut_metadata
 * - `'close'()` — connection gone (emitted once)
 */
export class PeerConnection extends EventEmitter {
  readonly wire: Wire;
  readonly socket: Socket;
  readonly host: string;
  readonly port: number;
  readonly outgoing: boolean;
  /** Our outstanding block requests to this peer. */
  inflight = 0;
  /** Set by the torrent once this peer's pieces are counted into availability. */
  counted = false;
  /** Remote peer id (hex) after handshake. */
  peerIdHex: string | undefined;
  private started = false;
  private expectedInfoHash: string | undefined;
  private ownPeerIdHex: string | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private _closed = false;

  constructor(socket: Socket, outgoing: boolean, addr?: { host: string; port: number }) {
    super();
    this.socket = socket;
    this.outgoing = outgoing;
    this.host = addr?.host ?? socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    this.port = addr?.port ?? socket.remotePort ?? 0;
    this.wire = new Wire(outgoing ? 'tcpOutgoing' : 'tcpIncoming');

    // Manual piping (Wire is a streamx Duplex).
    socket.on('data', (chunk: Buffer) => {
      if (!this._closed) this.wire.write(chunk);
    });
    this.wire.on('data', (chunk) => {
      if (!this._closed && !socket.destroyed) socket.write(chunk);
    });
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
    socket.on('end', () => this.destroy());
    this.wire.on('error', () => this.destroy());
    this.wire.on('finish', () => this.destroy());
    this.wire.on('close', () => this.destroy());
    socket.setNoDelay(true);

    this.wire.on('handshake', (infoHashHex, peerIdHex) => {
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      if (this.expectedInfoHash !== undefined && infoHashHex !== this.expectedInfoHash) {
        this.destroy();
        return;
      }
      if (this.ownPeerIdHex !== undefined && peerIdHex === this.ownPeerIdHex) {
        this.destroy(); // connected to ourselves
        return;
      }
      this.peerIdHex = peerIdHex;
      this.emit('handshake', infoHashHex, peerIdHex);
    });

    this.handshakeTimer = setTimeout(() => this.destroy(), HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref();
  }

  get closed(): boolean {
    return this._closed;
  }

  get key(): string {
    return `${this.host}:${this.port}`;
  }

  /** True once the remote handshake arrived and ours was sent. */
  get ready(): boolean {
    return this.started && this.peerIdHex !== undefined && !this._closed;
  }

  /**
   * Registers ut_metadata and sends our handshake. For incoming connections
   * call this from the `'handshake'` listener (after routing by info hash).
   */
  start(p: StartParams): void {
    if (this.started || this._closed) return;
    this.started = true;
    this.expectedInfoHash = toHex(p.infoHash);
    this.ownPeerIdHex = toHex(p.peerId);
    if (this.peerIdHex === this.ownPeerIdHex) {
      this.destroy();
      return;
    }
    this.wire.use(utMetadata(p.metadata));
    const ext = this.wire.ut_metadata;
    if (ext) {
      ext.on('metadata', (buf) => this.emit('metadata', buf));
      ext.on('warning', () => undefined);
    }
    this.wire.setKeepAlive(true);
    this.wire.setTimeout(REQUEST_TIMEOUT_MS, true);
    this.wire.handshake(p.infoHash, p.peerId, { dht: p.dht ?? false });
  }

  /** Ask this peer for the info dict (magnet resolution). */
  fetchMetadata(): void {
    this.wire.ut_metadata?.fetch();
  }

  /** Serve the info dict to this peer from now on. */
  setMetadata(infoBuf: Uint8Array): void {
    const ext = this.wire.ut_metadata;
    if (!ext) return;
    ext.cancel();
    void ext.setMetadata(infoBuf).catch(() => undefined);
  }

  /** True when the peer advertises every piece of an `n`-piece torrent. */
  isSeed(n: number): boolean {
    if (n <= 0) return false;
    for (let i = 0; i < n; i++) if (!this.wire.peerPieces.get(i)) return false;
    return true;
  }

  destroy(): void {
    if (this._closed) return;
    this._closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    try {
      this.wire.destroy();
    } catch {
      /* ignore */
    }
    this.socket.destroy();
    this.emit('close');
  }
}
