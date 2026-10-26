/**
 * Minimal ambient typings for pure-JS BitTorrent packages that ship no types.
 * Owner: coder-2 — refine as the torrent engine is implemented.
 */
declare module 'bencode' {
  export function encode(data: unknown): Uint8Array;
  export function decode<T = unknown>(data: Uint8Array, start?: number, end?: number, encoding?: string): T;
  export function byteLength(data: unknown): number;
}

declare module 'bittorrent-protocol' {
  import type { Duplex } from 'node:stream';
  export default class Wire extends Duplex {
    constructor();
    peerId: string;
    amChoking: boolean;
    amInterested: boolean;
    peerChoking: boolean;
    peerInterested: boolean;
    peerPieces: { get(i: number): boolean };
    peerExtensions: Record<string, boolean>;
    handshake(infoHash: string | Uint8Array, peerId: string | Uint8Array, extensions?: Record<string, boolean>): void;
    use(extension: unknown): void;
    interested(): void;
    uninterested(): void;
    choke(): void;
    unchoke(): void;
    have(index: number): void;
    bitfield(bitfield: Uint8Array | { buffer: Uint8Array }): void;
    request(index: number, offset: number, length: number, cb: (err: Error | null, block?: Uint8Array) => void): void;
    cancel(index: number, offset: number, length: number): void;
    piece(index: number, offset: number, buffer: Uint8Array): void;
    setTimeout(ms: number, unref?: boolean): void;
    setKeepAlive(enable: boolean): void;
    destroy(): void;
  }
}

declare module 'bittorrent-dht' {
  import { EventEmitter } from 'node:events';
  export interface DhtOptions {
    nodeId?: string | Uint8Array;
    bootstrap?: string[] | false;
    host?: string;
    concurrency?: number;
    maxTables?: number;
    timeBucketOutdated?: number;
  }
  export default class DHT extends EventEmitter {
    constructor(opts?: DhtOptions);
    listen(port?: number, cb?: () => void): void;
    lookup(infoHash: string | Uint8Array, cb?: (err: Error | null, nodesFound?: number) => void): () => void;
    announce(infoHash: string | Uint8Array, port?: number, cb?: (err: Error | null) => void): void;
    addNode(node: { host: string; port: number }): void;
    destroy(cb?: () => void): void;
    toJSON(): { nodes: Array<{ host: string; port: number }> };
    on(event: 'peer', listener: (peer: { host: string; port: number }, infoHash: Uint8Array, from: { host: string; port: number }) => void): this;
    on(event: 'ready' | 'listening', listener: () => void): this;
    on(event: 'error' | 'warning', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}

declare module 'ut_metadata' {
  export default function utMetadata(metadata?: Uint8Array): unknown;
}
