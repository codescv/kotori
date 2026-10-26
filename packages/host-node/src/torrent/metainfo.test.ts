import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  bencodeDecode,
  bencodeEncode,
  createTorrentFile,
  encodeTorrentFile,
  findInfoSpan,
  infoDictFromMetadata,
  normaliseInfoHash,
  parseMagnet,
  parseTorrentFile,
  sanitizePathComponent,
  toHex,
} from './metainfo';

function payload(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

const te = new TextEncoder();

describe('bencode', () => {
  it('round-trips nested structures', () => {
    const value = { a: 1, list: [te.encode('x'), 42, { nested: te.encode('y') }], z: te.encode('') };
    const enc = bencodeEncode(value);
    expect(new TextDecoder().decode(enc)).toBe('d1:ai1e4:listl1:xi42ed6:nested1:yee1:z0:e');
    expect(bencodeEncode(bencodeDecode(enc))).toEqual(enc);
  });
});

describe('createTorrentFile / parseTorrentFile', () => {
  it('round-trips a multi-file torrent and computes the info hash over the info dict', () => {
    const a = payload(40_000, 1);
    const b = payload(10, 2);
    const c = payload(70_001, 3);
    const bytes = createTorrentFile({
      name: 'Show S01',
      files: [
        { path: 'ep01.mkv', data: a },
        { path: 'subs/ep01.ass', data: b },
        { path: 'ep02.mkv', data: c },
      ],
      pieceLength: 16384,
      announce: ['udp://tracker.example:1337/announce', 'http://t2.example/announce'],
    });
    const meta = parseTorrentFile(bytes);
    expect(meta.name).toBe('Show S01');
    expect(meta.pieceLength).toBe(16384);
    expect(meta.length).toBe(110_011);
    expect(meta.pieces).toHaveLength(Math.ceil(110_011 / 16384));
    expect(meta.pieces.every((p) => p.length === 20)).toBe(true);
    expect(meta.files).toEqual([
      { index: 0, path: 'Show S01/ep01.mkv', length: 40_000, offset: 0 },
      { index: 1, path: 'Show S01/subs/ep01.ass', length: 10, offset: 40_000 },
      { index: 2, path: 'Show S01/ep02.mkv', length: 70_001, offset: 40_010 },
    ]);
    expect(meta.announce).toEqual(['udp://tracker.example:1337/announce', 'http://t2.example/announce']);

    const root = bencodeDecode(bytes) as Record<string, unknown>;
    const expectedHash = createHash('sha1').update(bencodeEncode(root['info'])).digest('hex');
    expect(meta.infoHash).toBe(expectedHash);
    expect(toHex(meta.infoHashBuf)).toBe(expectedHash);

    // Piece 2 spans file 0 → 1 → 2.
    const all = new Uint8Array([...a, ...b, ...c]);
    const p2 = createHash('sha1').update(all.subarray(2 * 16384, 3 * 16384)).digest();
    expect(Buffer.from(meta.pieces[2] ?? []).equals(p2)).toBe(true);
  });

  it('creates single-file torrents', () => {
    const meta = parseTorrentFile(createTorrentFile({ name: 'movie.mp4', files: [{ path: 'ignored', data: payload(1000, 9) }] }));
    expect(meta.files).toEqual([{ index: 0, path: 'movie.mp4', length: 1000, offset: 0 }]);
    expect(meta.pieceLength).toBe(16384);
    expect(meta.pieces).toHaveLength(1);
  });

  it('hashes the raw info bytes of non-canonical torrents', () => {
    // Keys deliberately unsorted ("piece length" after "pieces") — re-encoding would sort them.
    const pieces = createHash('sha1').update(new Uint8Array(5)).digest();
    const info = Buffer.concat([
      Buffer.from('d4:name1:x6:lengthi5e6:pieces20:'),
      pieces,
      Buffer.from('12:piece lengthi16384ee'),
    ]);
    const torrent = Buffer.concat([Buffer.from('d8:announce3:foo4:info'), info, Buffer.from('e')]);
    const meta = parseTorrentFile(new Uint8Array(torrent));
    expect(meta.infoHash).toBe(createHash('sha1').update(info).digest('hex'));
    expect(meta.announce).toEqual(['foo']);
    const span = findInfoSpan(new Uint8Array(torrent));
    expect(span && torrent.subarray(span.start, span.end).equals(info)).toBe(true);
  });

  it('sanitises path traversal', () => {
    expect(sanitizePathComponent('..')).toBe('_');
    expect(sanitizePathComponent('a/b\\c')).toBe('a_b_c');
    const bytes = bencodeEncode({
      info: {
        name: '..',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        files: [{ length: 1, path: ['..', 'etc', 'passwd'] }],
      },
    });
    expect(parseTorrentFile(bytes).files[0]?.path).toBe('_/_/etc/passwd');
  });

  it('rejects malformed torrents', () => {
    expect(() => parseTorrentFile(te.encode('i42e'))).toThrow();
    expect(() => parseTorrentFile(bencodeEncode({ announce: 'x' }))).toThrow(/info/);
  });

  it('infoDictFromMetadata accepts ut_metadata payloads and bare info dicts', () => {
    const meta = parseTorrentFile(createTorrentFile({ name: 'n', files: [{ path: 'n', data: payload(50_000, 4) }] }));
    const wrapped = new Uint8Array(Buffer.concat([Buffer.from('d4:info'), meta.infoBuf, Buffer.from('e')]));
    expect(infoDictFromMetadata(wrapped).infoHash).toBe(meta.infoHash);
    expect(infoDictFromMetadata(meta.infoBuf).infoHash).toBe(meta.infoHash);
  });

  it('encodeTorrentFile rebuilds an equivalent .torrent', () => {
    const meta = parseTorrentFile(
      createTorrentFile({ name: 'n', files: [{ path: 'n', data: payload(5, 5) }], announce: ['http://a/announce', 'udp://b:1/announce'] }),
    );
    const again = parseTorrentFile(encodeTorrentFile(meta));
    expect(again.infoHash).toBe(meta.infoHash);
    expect(again.announce).toEqual(meta.announce);
  });
});

describe('magnet', () => {
  const hex = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';

  it('parses hex btih, name, trackers and x.pe peers', () => {
    const m = parseMagnet(
      `magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=My%20Show&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce&tr=http%3A%2F%2Fa%2Fannounce&x.pe=127.0.0.1:6881&x.pe=[::1]:51413`,
    );
    expect(m.infoHash).toBe(hex);
    expect(m.name).toBe('My Show');
    expect(m.trackers).toEqual(['udp://tracker.example:1337/announce', 'http://a/announce']);
    expect(m.peers).toEqual([
      { host: '127.0.0.1', port: 6881 },
      { host: '::1', port: 51413 },
    ]);
  });

  it('parses base32 btih', () => {
    // base32 of the hex hash above
    const b32 = 'YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK';
    expect(toHex(base32Decode(b32))).toBe(hex);
    expect(parseMagnet(`magnet:?xt=urn:btih:${b32}`).infoHash).toBe(hex);
    expect(parseMagnet(`magnet:?xt=urn:btih:${b32.toLowerCase()}`).infoHash).toBe(hex);
    expect(normaliseInfoHash(b32)).toBe(hex);
  });

  it('rejects magnets without a valid btih', () => {
    expect(() => parseMagnet('magnet:?dn=x')).toThrow();
    expect(() => parseMagnet('magnet:?xt=urn:btih:1234')).toThrow();
    expect(() => parseMagnet('http://example.com')).toThrow();
  });
});
