/**
 * Shared tracker types and the HTTP(S) announce client (BEP 3 / BEP 23 compact peers).
 */
import { bencodeDecode } from './metainfo';

export type AnnounceEvent = 'started' | 'stopped' | 'completed' | 'update';

export interface AnnounceParams {
  readonly infoHash: Uint8Array;
  readonly peerId: Uint8Array;
  readonly port: number;
  readonly uploaded: number;
  readonly downloaded: number;
  readonly left: number;
  readonly event?: AnnounceEvent;
  readonly numWant?: number;
  /** Random per-client key (BEP 15 / HTTP `key`). */
  readonly key?: number;
}

export interface PeerAddress {
  readonly host: string;
  readonly port: number;
}

export interface AnnounceResult {
  /** Seconds until the next regular announce. */
  readonly interval: number;
  readonly peers: readonly PeerAddress[];
  readonly seeders?: number;
  readonly leechers?: number;
}

/** Percent-encodes raw bytes for a tracker query string (unreserved chars stay literal). */
export function encodeBinaryParam(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9.\-_~]/.test(c) ? c : `%${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Decodes BEP 23 compact IPv4 peers (6 bytes each). */
export function parseCompactPeers(buf: Uint8Array): PeerAddress[] {
  const out: PeerAddress[] = [];
  for (let i = 0; i + 6 <= buf.length; i += 6) {
    const port = ((buf[i + 4] ?? 0) << 8) | (buf[i + 5] ?? 0);
    if (port > 0) out.push({ host: `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`, port });
  }
  return out;
}

/** Decodes BEP 7 compact IPv6 peers (18 bytes each). */
export function parseCompactPeers6(buf: Uint8Array): PeerAddress[] {
  const out: PeerAddress[] = [];
  for (let i = 0; i + 18 <= buf.length; i += 18) {
    const groups: string[] = [];
    for (let g = 0; g < 8; g++) groups.push((((buf[i + 2 * g] ?? 0) << 8) | (buf[i + 2 * g + 1] ?? 0)).toString(16));
    const port = ((buf[i + 16] ?? 0) << 8) | (buf[i + 17] ?? 0);
    if (port > 0) out.push({ host: groups.join(':'), port });
  }
  return out;
}

const decoder = new TextDecoder();

/** Announces to an `http(s)://` tracker. Rejects on HTTP / tracker failure. */
export async function announceHttp(
  url: string,
  params: AnnounceParams,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<AnnounceResult> {
  const doFetch = opts.fetch ?? fetch;
  const q = [
    `info_hash=${encodeBinaryParam(params.infoHash)}`,
    `peer_id=${encodeBinaryParam(params.peerId)}`,
    `port=${params.port}`,
    `uploaded=${params.uploaded}`,
    `downloaded=${params.downloaded}`,
    `left=${params.left}`,
    'compact=1',
    `numwant=${params.numWant ?? 50}`,
  ];
  if (params.event && params.event !== 'update') q.push(`event=${params.event}`);
  if (params.key !== undefined) q.push(`key=${(params.key >>> 0).toString(16)}`);
  const full = `${url}${url.includes('?') ? '&' : '?'}${q.join('&')}`;
  const res = await doFetch(full, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  if (!res.ok) throw new Error(`tracker HTTP ${res.status}`);
  const body = bencodeDecode(new Uint8Array(await res.arrayBuffer()));
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('tracker returned invalid response');
  const dict = body as Record<string, unknown>;
  const failure = dict['failure reason'];
  if (failure instanceof Uint8Array) throw new Error(`tracker failure: ${decoder.decode(failure)}`);

  const peers: PeerAddress[] = [];
  const rawPeers = dict['peers'];
  if (rawPeers instanceof Uint8Array) {
    peers.push(...parseCompactPeers(rawPeers));
  } else if (Array.isArray(rawPeers)) {
    for (const p of rawPeers) {
      if (typeof p !== 'object' || p === null) continue;
      const rec = p as Record<string, unknown>;
      const ip = rec['ip'];
      const port = rec['port'];
      if (ip instanceof Uint8Array && typeof port === 'number' && port > 0) peers.push({ host: decoder.decode(ip), port });
    }
  }
  const rawPeers6 = dict['peers6'];
  if (rawPeers6 instanceof Uint8Array) peers.push(...parseCompactPeers6(rawPeers6));

  const interval = typeof dict['interval'] === 'number' ? dict['interval'] : 1800;
  const result: { interval: number; peers: PeerAddress[]; seeders?: number; leechers?: number } = { interval, peers };
  if (typeof dict['complete'] === 'number') result.seeders = dict['complete'];
  if (typeof dict['incomplete'] === 'number') result.leechers = dict['incomplete'];
  return result;
}
