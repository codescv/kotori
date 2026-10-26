/**
 * Minimal ambient typings for pure-JS BitTorrent packages that ship no types.
 * Owner: coder-2 — refine as the torrent engine is implemented.
 *
 * Only the surface actually used by `src/torrent/` is typed. All four packages
 * are ESM with a single default export.
 */
declare module 'bencode' {
  /** bencode@4: strings decode to `Uint8Array` unless `encoding` is given; dict keys are strings. */
  interface Bencode {
    encode(data: unknown): Uint8Array;
    decode(data: Uint8Array | string, start?: number, end?: number, encoding?: string): unknown;
    decode(data: Uint8Array | string, encoding?: string): unknown;
    byteLength(data: unknown): number;
    encodingLength(data: unknown): number;
  }
  const bencode: Bencode;
  export default bencode;
}

declare module 'bittorrent-protocol' {
  import { EventEmitter } from 'node:events';

  /** BitTorrent wire (a `streamx` Duplex). Write raw socket bytes in, read protocol bytes out. */
  export default class Wire extends EventEmitter {
    constructor(type?: string, peEnabled?: number);
    /** Remote peer id as hex (null until handshake). */
    peerId: string | null;
    peerIdBuffer: Uint8Array | null;
    amChoking: boolean;
    amInterested: boolean;
    peerChoking: boolean;
    peerInterested: boolean;
    peerPieces: { get(i: number): boolean; buffer: Uint8Array };
    peerExtensions: { dht?: boolean; fast?: boolean; extended?: boolean };
    extendedHandshake: Record<string, unknown>;
    peerExtendedHandshake: Record<string, unknown>;
    requests: unknown[];
    peerRequests: unknown[];
    uploaded: number;
    downloaded: number;
    destroyed: boolean;
    /** Present after `use(ut_metadata(...))`. */
    ut_metadata?: import('ut_metadata').UtMetadataExtension;

    write(chunk: Uint8Array): boolean;
    end(): void;
    destroy(): void;
    /** `infoHash` / `peerId` as Uint8Array or **hex** string (20 bytes). */
    handshake(infoHash: string | Uint8Array, peerId: string | Uint8Array, extensions?: { dht?: boolean; fast?: boolean }): void;
    use(extension: unknown): void;
    interested(): void;
    uninterested(): void;
    choke(): void;
    unchoke(): void;
    have(index: number): void;
    bitfield(bitfield: Uint8Array): void;
    request(index: number, offset: number, length: number, cb: (err: Error | null, block?: Uint8Array | null) => void): void;
    cancel(index: number, offset: number, length: number): void;
    piece(index: number, offset: number, buffer: Uint8Array): void;
    port(port: number): void;
    setTimeout(ms: number, unref?: boolean): void;
    setKeepAlive(enable: boolean): void;

    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'handshake', listener: (infoHashHex: string, peerIdHex: string, extensions: { dht?: boolean; fast?: boolean; extended?: boolean }) => void): this;
    on(event: 'bitfield', listener: (bitfield: { get(i: number): boolean }) => void): this;
    on(event: 'have', listener: (index: number) => void): this;
    on(
      event: 'request',
      listener: (index: number, offset: number, length: number, respond: (err: Error | null, buf?: Uint8Array) => void) => void,
    ): this;
    on(event: 'choke' | 'unchoke' | 'interested' | 'uninterested' | 'end' | 'finish' | 'close' | 'timeout', listener: () => void): this;
    on(event: 'extended', listener: (ext: string | number, payload: unknown) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
  }
}

declare module 'bittorrent-dht' {
  import { EventEmitter } from 'node:events';
  export interface DhtOptions {
    nodeId?: string | Uint8Array;
    bootstrap?: string[] | false;
    host?: string | false;
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
    address(): { address: string; family: string; port: number } | null;
    toJSON(): { nodes: Array<{ host: string; port: number }> };
    on(event: 'peer', listener: (peer: { host: string; port: number }, infoHash: Uint8Array, from: { host: string; port: number } | null) => void): this;
    on(event: 'ready' | 'listening', listener: () => void): this;
    on(event: 'error' | 'warning', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
  }
}

declare module 'ut_metadata' {
  import { EventEmitter } from 'node:events';
  /** Per-wire BEP 9 extension instance (`wire.ut_metadata`). */
  export interface UtMetadataExtension extends EventEmitter {
    /** Raw bencoded info dict once known. */
    metadata?: Uint8Array;
    fetch(): void;
    cancel(): void;
    setMetadata(metadata: Uint8Array): Promise<boolean>;
    /** `metadata` is the bencoded `{ info: <info dict> }`. */
    on(event: 'metadata', listener: (metadata: Uint8Array) => void): this;
    on(event: 'warning', listener: (err: Error) => void): this;
  }
  /** Returns an extension constructor for `wire.use()`. Pass the info dict when we already have it. */
  export default function utMetadata(metadata?: Uint8Array): unknown;
}
