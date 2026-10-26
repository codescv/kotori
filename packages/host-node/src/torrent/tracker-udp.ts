/**
 * BEP 15 UDP tracker client over a single shared `node:dgram` socket, with a
 * per-tracker connection-id cache (valid 60 s) and exponential-backoff retries.
 */
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { parseCompactPeers } from './tracker-http';
import type { AnnounceParams, AnnounceResult } from './tracker-http';

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;
const CONNECTION_ID_TTL_MS = 60_000;

const EVENT_CODES = { update: 0, completed: 1, started: 2, stopped: 3 } as const;

export interface UdpTrackerOptions {
  /** Base timeout per attempt; doubles on each retry (BEP 15 uses 15 s). Default 15000. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  readonly retries?: number;
}

interface Pending {
  resolve(buf: Buffer): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** Parses `udp://host:port[/path]`. */
export function parseUdpUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  if (u.protocol !== 'udp:') throw new Error(`not a udp tracker: ${url}`);
  const port = Number(u.port);
  if (!port) throw new Error(`udp tracker without port: ${url}`);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

export class UdpTrackerClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private socket: Socket | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly connIds = new Map<string, { id: Buffer; expires: number }>();
  private destroyed = false;

  constructor(opts: UdpTrackerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
  }

  private getSocket(): Socket {
    if (this.destroyed) throw new Error('udp tracker client destroyed');
    if (!this.socket) {
      const s = createSocket('udp4');
      s.on('message', (msg) => this.onMessage(msg));
      s.on('error', () => undefined);
      s.unref();
      this.socket = s;
    }
    return this.socket;
  }

  private onMessage(msg: Buffer): void {
    if (msg.length < 8) return;
    const tid = msg.readUInt32BE(4);
    const p = this.pending.get(tid);
    if (!p) return;
    this.pending.delete(tid);
    clearTimeout(p.timer);
    if (msg.readUInt32BE(0) === ACTION_ERROR) p.reject(new Error(`tracker error: ${msg.subarray(8).toString('utf8')}`));
    else p.resolve(msg);
  }

  /** Sends one datagram and waits for the reply with matching transaction id. */
  private transact(host: string, port: number, build: (tid: number) => Buffer, timeoutMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const tid = randomBytes(4).readUInt32BE(0);
      const timer = setTimeout(() => {
        this.pending.delete(tid);
        reject(new Error('udp tracker timeout'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(tid, { resolve, reject, timer });
      this.getSocket().send(build(tid), port, host, (err) => {
        if (!err) return;
        this.pending.delete(tid);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async connectionId(host: string, port: number, timeoutMs: number): Promise<Buffer> {
    const key = `${host}:${port}`;
    const cached = this.connIds.get(key);
    if (cached && cached.expires > Date.now()) return cached.id;
    const res = await this.transact(
      host,
      port,
      (tid) => {
        const b = Buffer.alloc(16);
        b.writeBigUInt64BE(PROTOCOL_ID, 0);
        b.writeUInt32BE(ACTION_CONNECT, 8);
        b.writeUInt32BE(tid, 12);
        return b;
      },
      timeoutMs,
    );
    if (res.length < 16 || res.readUInt32BE(0) !== ACTION_CONNECT) throw new Error('bad udp connect response');
    const id = Buffer.from(res.subarray(8, 16));
    this.connIds.set(key, { id, expires: Date.now() + CONNECTION_ID_TTL_MS });
    return id;
  }

  /** Announces to a `udp://` tracker. */
  async announce(url: string, params: AnnounceParams): Promise<AnnounceResult> {
    const { host, port } = parseUdpUrl(url);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const timeoutMs = this.timeoutMs * 2 ** attempt;
      try {
        const connId = await this.connectionId(host, port, timeoutMs);
        const res = await this.transact(host, port, (tid) => buildAnnounce(connId, tid, params), timeoutMs);
        if (res.length < 20 || res.readUInt32BE(0) !== ACTION_ANNOUNCE) throw new Error('bad udp announce response');
        return {
          interval: res.readUInt32BE(8),
          leechers: res.readUInt32BE(12),
          seeders: res.readUInt32BE(16),
          peers: parseCompactPeers(res.subarray(20)),
        };
      } catch (err) {
        lastErr = err;
        // A lost reply may mean our connection id expired server-side: reconnect next time.
        this.connIds.delete(`${host}:${port}`);
        if (this.destroyed || (err instanceof Error && err.message.startsWith('tracker error'))) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  destroy(): void {
    this.destroyed = true;
    for (const [tid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('udp tracker client destroyed'));
      this.pending.delete(tid);
    }
    this.socket?.close();
    this.socket = undefined;
  }
}

function buildAnnounce(connId: Buffer, tid: number, p: AnnounceParams): Buffer {
  const b = Buffer.alloc(98);
  connId.copy(b, 0);
  b.writeUInt32BE(ACTION_ANNOUNCE, 8);
  b.writeUInt32BE(tid, 12);
  Buffer.from(p.infoHash).copy(b, 16);
  Buffer.from(p.peerId).copy(b, 36);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(p.downloaded))), 56);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(p.left))), 64);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(p.uploaded))), 72);
  b.writeUInt32BE(EVENT_CODES[p.event ?? 'update'], 80);
  b.writeUInt32BE(0, 84); // IP: default
  b.writeUInt32BE((p.key ?? 0) >>> 0, 88);
  b.writeInt32BE(p.numWant ?? 50, 92);
  b.writeUInt16BE(p.port & 0xffff, 96);
  return b;
}
