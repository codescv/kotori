import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bencodeEncode } from './metainfo';
import { announceHttp, encodeBinaryParam, parseCompactPeers } from './tracker-http';
import { parseUdpUrl, UdpTrackerClient } from './tracker-udp';

const infoHash = new Uint8Array(20).fill(0xab);
const peerId = new TextEncoder().encode('-KT0100-abcdefghijkl');
const params = { infoHash, peerId, port: 6881, uploaded: 1, downloaded: 2, left: 3, event: 'started' as const, numWant: 10, key: 7 };

interface FakeTracker {
  socket: Socket;
  port: number;
  connects: number;
  announces: Array<{ connId: bigint; event: number; port: number; left: bigint; infoHash: string }>;
  dropNext: number;
}

/** In-process BEP 15 tracker. */
async function fakeUdpTracker(): Promise<FakeTracker> {
  const socket = createSocket('udp4');
  const t: FakeTracker = { socket, port: 0, connects: 0, announces: [], dropNext: 0 };
  const CONN_ID = 0x1122334455667788n;
  socket.on('message', (msg, rinfo) => {
    if (t.dropNext > 0) {
      t.dropNext--;
      return;
    }
    const action = msg.readUInt32BE(8);
    const tid = msg.readUInt32BE(12);
    if (action === 0) {
      expect(msg.readBigUInt64BE(0)).toBe(0x41727101980n);
      t.connects++;
      const res = Buffer.alloc(16);
      res.writeUInt32BE(0, 0);
      res.writeUInt32BE(tid, 4);
      res.writeBigUInt64BE(CONN_ID, 8);
      socket.send(res, rinfo.port, rinfo.address);
    } else if (action === 1) {
      const connId = msg.readBigUInt64BE(0);
      t.announces.push({
        connId,
        event: msg.readUInt32BE(80),
        port: msg.readUInt16BE(96),
        left: msg.readBigUInt64BE(64),
        infoHash: msg.subarray(16, 36).toString('hex'),
      });
      if (connId !== CONN_ID) {
        const err = Buffer.concat([Buffer.alloc(8), Buffer.from('bad connection id')]);
        err.writeUInt32BE(3, 0);
        err.writeUInt32BE(tid, 4);
        socket.send(err, rinfo.port, rinfo.address);
        return;
      }
      const res = Buffer.alloc(20 + 12);
      res.writeUInt32BE(1, 0);
      res.writeUInt32BE(tid, 4);
      res.writeUInt32BE(900, 8);
      res.writeUInt32BE(4, 12);
      res.writeUInt32BE(9, 16);
      Buffer.from([10, 0, 0, 1, 0x1a, 0xe1, 127, 0, 0, 1, 0xc8, 0xd5]).copy(res, 20);
      socket.send(res, rinfo.port, rinfo.address);
    }
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()));
  t.port = (socket.address() as AddressInfo).port;
  return t;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('UDP tracker (BEP 15)', () => {
  it('parses udp URLs', () => {
    expect(parseUdpUrl('udp://tracker.opentrackr.org:1337/announce')).toEqual({ host: 'tracker.opentrackr.org', port: 1337 });
    expect(() => parseUdpUrl('http://x/announce')).toThrow();
  });

  it('connects, announces, and reuses the cached connection id', async () => {
    const t = await fakeUdpTracker();
    const client = new UdpTrackerClient({ timeoutMs: 200, retries: 2 });
    cleanups.push(() => {
      client.destroy();
      t.socket.close();
    });
    const url = `udp://127.0.0.1:${t.port}/announce`;
    const res = await client.announce(url, params);
    expect(res).toEqual({
      interval: 900,
      leechers: 4,
      seeders: 9,
      peers: [
        { host: '10.0.0.1', port: 6881 },
        { host: '127.0.0.1', port: 51413 },
      ],
    });
    expect(t.announces[0]).toMatchObject({ event: 2, port: 6881, left: 3n, infoHash: 'ab'.repeat(20) });
    await client.announce(url, { ...params, event: 'completed' });
    expect(t.connects).toBe(1);
    expect(t.announces.map((a) => a.event)).toEqual([2, 1]);
  });

  it('retries after lost datagrams', async () => {
    const t = await fakeUdpTracker();
    const client = new UdpTrackerClient({ timeoutMs: 100, retries: 3 });
    cleanups.push(() => {
      client.destroy();
      t.socket.close();
    });
    t.dropNext = 2; // lose the first connect, then the first-retry connect
    const res = await client.announce(`udp://127.0.0.1:${t.port}/announce`, params);
    expect(res.peers).toHaveLength(2);
    expect(t.connects).toBe(1);
  });

  it('gives up after the retry budget', async () => {
    const t = await fakeUdpTracker();
    const client = new UdpTrackerClient({ timeoutMs: 30, retries: 1 });
    cleanups.push(() => {
      client.destroy();
      t.socket.close();
    });
    t.dropNext = 100;
    await expect(client.announce(`udp://127.0.0.1:${t.port}/announce`, params)).rejects.toThrow(/timeout/);
  });
});

describe('HTTP tracker', () => {
  it('encodes binary params and parses compact responses', async () => {
    expect(encodeBinaryParam(new Uint8Array([0x41, 0x00, 0xff, 0x2e]))).toBe('A%00%ff.');
    expect(parseCompactPeers(new Uint8Array([1, 2, 3, 4, 0, 80]))).toEqual([{ host: '1.2.3.4', port: 80 }]);

    let seenUrl = '';
    const server = createServer((req, res) => {
      seenUrl = req.url ?? '';
      res.end(Buffer.from(bencodeEncode({ interval: 120, complete: 3, incomplete: 1, peers: new Uint8Array([127, 0, 0, 1, 0x1a, 0xe1]) })));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const res = await announceHttp(`http://127.0.0.1:${port}/announce`, params);
    expect(res).toEqual({ interval: 120, seeders: 3, leechers: 1, peers: [{ host: '127.0.0.1', port: 6881 }] });
    expect(seenUrl).toContain(`info_hash=${'%ab'.repeat(20)}`);
    expect(seenUrl).toContain('peer_id=-KT0100-abcdefghijkl');
    expect(seenUrl).toContain('event=started');
    expect(seenUrl).toContain('compact=1');
  });

  it('surfaces tracker failure reasons', async () => {
    const server = createServer((_req, res) => res.end(Buffer.from(bencodeEncode({ 'failure reason': 'unregistered torrent' }))));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    await expect(announceHttp(`http://127.0.0.1:${port}/announce`, params)).rejects.toThrow(/unregistered torrent/);
  });
});
