/**
 * Thin wrapper over `bittorrent-dht` (BEP 5): one node per client, peer
 * lookups routed back by info hash. Disabled in tests (`dht: false`).
 */
import { EventEmitter } from 'node:events';
import DHT from 'bittorrent-dht';
import { toHex } from './metainfo';
import type { PeerAddress } from './tracker-http';

export interface DhtNodeOptions {
  /** UDP port (we reuse the TCP listen port, as is customary). */
  readonly port: number;
  /** Override bootstrap nodes; `false` for an isolated node. */
  readonly bootstrap?: string[] | false;
}

/** Events: `'peer'(peer: PeerAddress, infoHashHex: string)`, `'warning'(Error)`. */
export class DhtNode extends EventEmitter {
  private readonly dht: DHT;
  private readonly port: number;
  private started = false;
  private destroyed = false;

  constructor(opts: DhtNodeOptions) {
    super();
    this.port = opts.port;
    this.dht = new DHT(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap });
    this.dht.on('peer', (peer, infoHash) => this.emit('peer', { host: peer.host, port: peer.port }, toHex(infoHash)));
    this.dht.on('error', (err) => this.emit('warning', err));
    this.dht.on('warning', (err) => this.emit('warning', err));
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    return new Promise((resolve) => {
      try {
        this.dht.listen(this.port, () => resolve());
      } catch (err) {
        this.emit('warning', err instanceof Error ? err : new Error(String(err)));
        resolve();
      }
    });
  }

  /** Starts a lookup; peers arrive as `'peer'` events. */
  lookup(infoHashHex: string): void {
    if (this.destroyed) return;
    this.dht.lookup(infoHashHex, (err) => {
      if (err) this.emit('warning', err);
    });
  }

  /** Announces that we serve `infoHashHex` on TCP `port`. */
  announce(infoHashHex: string, port: number): void {
    if (this.destroyed) return;
    this.dht.announce(infoHashHex, port, (err) => {
      if (err) this.emit('warning', err);
    });
  }

  addNode(node: PeerAddress): void {
    this.dht.addNode({ host: node.host, port: node.port });
  }

  destroy(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    return new Promise((resolve) => this.dht.destroy(() => resolve()));
  }
}
