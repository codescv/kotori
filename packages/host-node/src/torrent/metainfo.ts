/**
 * Torrent metainfo: `.torrent` parsing / creation, info-hash computation and
 * magnet URI parsing (hex + base32 `btih`).
 *
 * The info hash is always computed over the **raw** `info` dictionary bytes as
 * they appear in the input (never a re-encoding), so non-canonical torrents
 * keep their real hash.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import bencode from 'bencode';

/** One file inside a torrent, in torrent order. */
export interface TorrentFileEntry {
  readonly index: number;
  /** Forward-slash path relative to the download dir (includes the torrent name dir for multi-file torrents). */
  readonly path: string;
  readonly length: number;
  /** Byte offset of this file inside the concatenated torrent payload. */
  readonly offset: number;
}

/** Parsed torrent metainfo. */
export interface TorrentMeta {
  /** Lower-case hex SHA-1 of the raw info dict. */
  readonly infoHash: string;
  readonly infoHashBuf: Uint8Array;
  readonly name: string;
  readonly pieceLength: number;
  /** 20-byte SHA-1 per piece. */
  readonly pieces: readonly Uint8Array[];
  readonly files: readonly TorrentFileEntry[];
  /** Total payload length. */
  readonly length: number;
  /** Flattened, de-duplicated tracker URLs (`announce` + `announce-list`). */
  readonly announce: readonly string[];
  /** Raw bencoded info dict (what ut_metadata serves). */
  readonly infoBuf: Uint8Array;
  readonly private: boolean;
}

/** Parsed magnet URI. */
export interface MagnetInfo {
  readonly infoHash: string;
  readonly name?: string;
  readonly trackers: readonly string[];
  /** BEP 9 `x.pe` peer addresses. */
  readonly peers: readonly { host: string; port: number }[];
}

type BDict = Record<string, unknown>;

const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** Typed wrapper around `bencode.encode`. */
export function bencodeEncode(value: unknown): Uint8Array {
  return bencode.encode(value);
}

/** Typed wrapper around `bencode.decode` (strings stay `Uint8Array`). */
export function bencodeDecode(bytes: Uint8Array): unknown {
  return bencode.decode(bytes);
}

/** Lower-case hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** SHA-1 digest. */
export function sha1(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha1').update(bytes).digest());
}

function isDict(v: unknown): v is BDict {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

function asText(v: unknown): string | undefined {
  if (v instanceof Uint8Array) return textDecoder.decode(v);
  if (typeof v === 'string') return v;
  return undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Locates the byte range of the top-level `info` value inside a bencoded
 * dictionary, without decoding it. Returns `undefined` when absent.
 */
export function findInfoSpan(bytes: Uint8Array): { start: number; end: number } | undefined {
  if (bytes[0] !== 0x64 /* d */) return undefined;
  let pos = 1;

  // Skip one bencoded value starting at `p`, returning the position after it.
  const skip = (p: number): number => {
    const c = bytes[p];
    if (c === undefined) throw new Error('truncated bencode');
    if (c === 0x69 /* i */) {
      const e = bytes.indexOf(0x65, p);
      if (e < 0) throw new Error('truncated int');
      return e + 1;
    }
    if (c === 0x6c /* l */ || c === 0x64 /* d */) {
      let q = p + 1;
      while (bytes[q] !== 0x65) {
        if (q >= bytes.length) throw new Error('truncated container');
        q = skip(q);
      }
      return q + 1;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = bytes.indexOf(0x3a, p);
      if (colon < 0) throw new Error('truncated string');
      const len = Number(textDecoder.decode(bytes.subarray(p, colon)));
      return colon + 1 + len;
    }
    throw new Error(`invalid bencode at ${p}`);
  };

  while (pos < bytes.length && bytes[pos] !== 0x65) {
    const keyStart = pos;
    const keyEnd = skip(keyStart);
    const colon = bytes.indexOf(0x3a, keyStart);
    const key = textDecoder.decode(bytes.subarray(colon + 1, keyEnd));
    const valEnd = skip(keyEnd);
    if (key === 'info') return { start: keyEnd, end: valEnd };
    pos = valEnd;
  }
  return undefined;
}

/** Makes one path component safe for the local filesystem (no traversal, no separators). */
export function sanitizePathComponent(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u001f/\\]/g, '_').trim();
  if (s === '' || s === '.' || s === '..') s = '_';
  return s;
}

function parseAnnounce(root: BDict): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    const s = asText(v);
    if (s && !out.includes(s)) out.push(s);
  };
  const list = root['announce-list'];
  if (Array.isArray(list)) {
    for (const tier of list) {
      if (Array.isArray(tier)) for (const u of tier) push(u);
      else push(tier);
    }
  }
  push(root['announce']);
  return out;
}

/**
 * Parses a raw bencoded info dict into {@link TorrentMeta}.
 * `announce` is supplied by the caller (it lives outside the info dict).
 */
export function parseInfoDict(infoBuf: Uint8Array, announce: readonly string[] = []): TorrentMeta {
  const info = bencodeDecode(infoBuf);
  if (!isDict(info)) throw new Error('info is not a dictionary');
  const rawName = asText(info['name.utf-8']) ?? asText(info['name']);
  if (rawName === undefined) throw new Error('info.name missing');
  const name = sanitizePathComponent(rawName);
  const pieceLength = asInt(info['piece length']);
  if (!pieceLength) throw new Error('info["piece length"] missing');
  const piecesRaw = info['pieces'];
  if (!(piecesRaw instanceof Uint8Array) || piecesRaw.length % 20 !== 0) throw new Error('info.pieces invalid');

  const files: TorrentFileEntry[] = [];
  let offset = 0;
  const filesRaw = info['files'];
  if (Array.isArray(filesRaw)) {
    filesRaw.forEach((f, index) => {
      if (!isDict(f)) throw new Error('info.files entry invalid');
      const length = asInt(f['length']);
      const parts = f['path.utf-8'] ?? f['path'];
      if (length === undefined || !Array.isArray(parts)) throw new Error('info.files entry invalid');
      const comps = parts.map((p) => sanitizePathComponent(asText(p) ?? '_'));
      files.push({ index, path: [name, ...comps].join('/'), length, offset });
      offset += length;
    });
  } else {
    const length = asInt(info['length']);
    if (length === undefined) throw new Error('info.length missing');
    files.push({ index: 0, path: name, length, offset: 0 });
    offset = length;
  }

  const pieces: Uint8Array[] = [];
  for (let i = 0; i < piecesRaw.length; i += 20) pieces.push(piecesRaw.slice(i, i + 20));
  if (pieces.length !== Math.ceil(offset / pieceLength)) throw new Error('piece count does not match payload length');

  const infoHashBuf = sha1(infoBuf);
  return {
    infoHash: toHex(infoHashBuf),
    infoHashBuf,
    name,
    pieceLength,
    pieces,
    files,
    length: offset,
    announce: [...announce],
    infoBuf: new Uint8Array(infoBuf),
    private: info['private'] === 1,
  };
}

/** Parses `.torrent` file bytes. Throws on malformed input. */
export function parseTorrentFile(bytes: Uint8Array): TorrentMeta {
  const root = bencodeDecode(bytes);
  if (!isDict(root)) throw new Error('torrent is not a dictionary');
  const span = findInfoSpan(bytes);
  if (!span) throw new Error('torrent has no info dictionary');
  return parseInfoDict(bytes.subarray(span.start, span.end), parseAnnounce(root));
}

/**
 * Accepts metadata as delivered by ut_metadata (bencoded `{ info }`) or a bare
 * info dict and returns the parsed metainfo.
 */
export function infoDictFromMetadata(bytes: Uint8Array, announce: readonly string[] = []): TorrentMeta {
  const span = findInfoSpan(bytes);
  if (span) {
    const decoded = bencodeDecode(bytes);
    const extra = isDict(decoded) ? parseAnnounce(decoded) : [];
    return parseInfoDict(bytes.subarray(span.start, span.end), [...new Set([...announce, ...extra])]);
  }
  return parseInfoDict(bytes, announce);
}

/** Builds a `.torrent` file (bencoded) from parsed metainfo, e.g. to persist a resolved magnet. */
export function encodeTorrentFile(meta: TorrentMeta): Uint8Array {
  const head: BDict = {};
  if (meta.announce[0]) head['announce'] = meta.announce[0];
  if (meta.announce.length > 1) head['announce-list'] = meta.announce.map((u) => [u]);
  // Keys must be sorted; 'announce*' < 'info'. Splice the raw info bytes in.
  const prefix = bencodeEncode(head);
  const out = new Uint8Array(prefix.length - 1 + 6 + meta.infoBuf.length + 1);
  out.set(prefix.subarray(0, prefix.length - 1), 0);
  let p = prefix.length - 1;
  out.set(new TextEncoder().encode('4:info'), p);
  p += 6;
  out.set(meta.infoBuf, p);
  p += meta.infoBuf.length;
  out[p] = 0x65;
  return out;
}

// ---------------------------------------------------------------------------
// Magnet
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 decode (no padding required). */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Normalises a 40-char hex or 32-char base32 info hash to lower-case hex; `undefined` when invalid. */
export function normaliseInfoHash(raw: string): string | undefined {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z2-7]{32}$/.test(s)) return toHex(base32Decode(s));
  return undefined;
}

function parseHostPort(raw: string): { host: string; port: number } | undefined {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(raw.trim());
  if (!m || !m[1] || !m[2]) return undefined;
  const port = Number(m[2]);
  if (port <= 0 || port > 65535) return undefined;
  return { host: m[1], port };
}

/** Parses a `magnet:?xt=urn:btih:…` URI. Throws when no valid btih is present. */
export function parseMagnet(uri: string): MagnetInfo {
  const trimmed = uri.trim();
  if (!/^magnet:\?/i.test(trimmed)) throw new Error('not a magnet URI');
  const params = new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1));
  let infoHash: string | undefined;
  let name: string | undefined;
  const trackers: string[] = [];
  const peers: { host: string; port: number }[] = [];
  for (const [rawKey, value] of params) {
    const key = rawKey.replace(/\.\d+$/, ''); // xt.1, tr.2 …
    if (key === 'xt') {
      const m = /^urn:btih:(.+)$/i.exec(value);
      if (m?.[1] && !infoHash) infoHash = normaliseInfoHash(m[1]);
    } else if (key === 'dn') {
      name = value;
    } else if (key === 'tr') {
      if (!trackers.includes(value)) trackers.push(value);
    } else if (key === 'x.pe') {
      const p = parseHostPort(value);
      if (p) peers.push(p);
    }
  }
  if (!infoHash) throw new Error('magnet has no valid urn:btih');
  return name === undefined ? { infoHash, trackers, peers } : { infoHash, name, trackers, peers };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** One input file for {@link createTorrentFile}: in-memory `data` or an on-disk `filePath`. */
export type CreateTorrentFileInput =
  | { readonly path: string; readonly data: Uint8Array }
  | { readonly path: string; readonly filePath: string; readonly length?: number };

export interface CreateTorrentOptions {
  readonly name: string;
  /**
   * Files in torrent order. A single file produces a single-file torrent named
   * `name` (its `path` is ignored); several files produce a multi-file torrent
   * whose entries live under `name/`.
   */
  readonly files: readonly CreateTorrentFileInput[];
  /** Power of two ≥ 16 KiB. Default: chosen for ~1000–2000 pieces (16 KiB … 4 MiB). */
  readonly pieceLength?: number;
  readonly announce?: readonly string[];
  readonly private?: boolean;
}

/** Default piece length for a payload size. */
export function defaultPieceLength(totalBytes: number): number {
  let len = 16 * 1024;
  while (len < 4 * 1024 * 1024 && totalBytes / len > 1500) len *= 2;
  return len;
}

/**
 * Builds `.torrent` bytes, hashing the payload synchronously (files are
 * streamed from disk in piece-sized chunks). Intended for tests and seeding
 * local files.
 */
export function createTorrentFile(opts: CreateTorrentOptions): Uint8Array {
  if (opts.files.length === 0) throw new Error('createTorrentFile: no files');
  const lengths = opts.files.map((f) => {
    if ('data' in f) return f.data.length;
    return f.length ?? statSync(f.filePath).size;
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  const pieceLength = opts.pieceLength ?? defaultPieceLength(total);

  // Stream all file bytes through a piece-sized buffer.
  const hashes: Uint8Array[] = [];
  const buf = new Uint8Array(pieceLength);
  let fill = 0;
  const flush = (): void => {
    hashes.push(sha1(buf.subarray(0, fill)));
    fill = 0;
  };
  const feed = (chunk: Uint8Array): void => {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(pieceLength - fill, chunk.length - off);
      buf.set(chunk.subarray(off, off + n), fill);
      fill += n;
      off += n;
      if (fill === pieceLength) flush();
    }
  };
  opts.files.forEach((f, i) => {
    if ('data' in f) {
      feed(f.data);
      return;
    }
    const fd = openSync(f.filePath, 'r');
    try {
      const chunk = new Uint8Array(Math.max(pieceLength, 1 << 20));
      let remaining = lengths[i] ?? 0;
      let pos = 0;
      while (remaining > 0) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, remaining), pos);
        if (n <= 0) throw new Error(`short read: ${f.filePath}`);
        feed(chunk.subarray(0, n));
        pos += n;
        remaining -= n;
      }
    } finally {
      closeSync(fd);
    }
  });
  if (fill > 0) flush();

  const pieces = new Uint8Array(hashes.length * 20);
  hashes.forEach((h, i) => pieces.set(h, i * 20));

  const info: BDict = { name: opts.name, 'piece length': pieceLength, pieces };
  if (opts.files.length === 1) {
    info['length'] = lengths[0];
  } else {
    info['files'] = opts.files.map((f, i) => ({
      length: lengths[i],
      path: f.path.split('/').filter((p) => p !== ''),
    }));
  }
  if (opts.private) info['private'] = 1;

  const root: BDict = { info, 'created by': 'Kotori/0.1.0', 'creation date': Math.floor(Date.now() / 1000) };
  const announce = opts.announce ?? [];
  if (announce[0]) root['announce'] = announce[0];
  if (announce.length > 1) root['announce-list'] = announce.map((u) => [u]);
  return bencodeEncode(root);
}
