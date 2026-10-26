/**
 * Magnet URI helpers (BitTorrent v1 `urn:btih:`), hex and base32 info hashes.
 */
import { KotoriError } from '../util/errors';

/** Parts of a magnet link Kotori cares about. */
export interface MagnetParts {
  /** Lower-case 40-char hex info hash. */
  readonly infoHash: string;
  /** `dn` display name. */
  readonly name?: string;
  /** `tr` tracker URLs in order, de-duplicated. */
  readonly trackers: string[];
}

/** Input for `buildMagnet`. */
export interface BuildMagnetInput {
  /** 40-char hex or 32-char base32 info hash (any case). */
  readonly infoHash: string;
  readonly name?: string;
  readonly trackers?: readonly string[];
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode an RFC 4648 base32 string (no padding) into lower-case hex.
 * Returns `undefined` on invalid characters.
 */
function base32ToHex(input: string): string | undefined {
  let bits = 0;
  let value = 0;
  let hex = '';
  for (const ch of input.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return undefined;
    value = (value << 5) | idx;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      hex += ((value >>> bits) & 0xff).toString(16).padStart(2, '0');
    }
    value &= (1 << bits) - 1;
  }
  return hex;
}

/**
 * Normalise a BitTorrent v1 info hash to lower-case hex.
 *
 * @param hash 40 hex chars or 32 base32 chars.
 * @returns The lower-case hex hash, or `undefined` if `hash` is neither.
 */
export function normaliseInfoHash(hash: string): string | undefined {
  const h = hash.trim();
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(h)) return base32ToHex(h);
  return undefined;
}

/** `decodeURIComponent` that treats `+` as space and never throws. */
function decodeParam(value: string): string {
  const v = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Parse a `magnet:?xt=urn:btih:…` URI.
 *
 * Accepts hex or base32 `btih`, `xt.1`-style numbered keys and `tr.N`
 * trackers. Throws `KotoriError('invalid-argument')` when the URI is not a
 * magnet link or carries no BitTorrent v1 info hash.
 */
export function parseMagnet(uri: string): MagnetParts {
  const text = uri.trim();
  if (!/^magnet:\?/i.test(text)) {
    throw new KotoriError('invalid-argument', 'Not a magnet URI', { details: { uri } });
  }
  let infoHash: string | undefined;
  let name: string | undefined;
  const trackers: string[] = [];
  for (const pair of text.slice('magnet:?'.length).split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const value = decodeParam(pair.slice(eq + 1));
    if (key === 'xt' || key.startsWith('xt.')) {
      const m = /^urn:btih:(.+)$/i.exec(value);
      if (m && infoHash === undefined) infoHash = normaliseInfoHash(m[1] as string);
    } else if (key === 'dn' && name === undefined) {
      name = value;
    } else if ((key === 'tr' || key.startsWith('tr.')) && value !== '' && !trackers.includes(value)) {
      trackers.push(value);
    }
  }
  if (infoHash === undefined) {
    throw new KotoriError('invalid-argument', 'Magnet URI has no valid urn:btih info hash', { details: { uri } });
  }
  return name === undefined ? { infoHash, trackers } : { infoHash, name, trackers };
}

/**
 * Build a magnet URI `magnet:?xt=urn:btih:<hex>&dn=<name>&tr=<tracker>…`.
 * All values are percent-encoded (as nyaa.si does). Throws
 * `KotoriError('invalid-argument')` for an invalid info hash.
 */
export function buildMagnet(parts: BuildMagnetInput): string {
  const hash = normaliseInfoHash(parts.infoHash);
  if (hash === undefined) {
    throw new KotoriError('invalid-argument', 'Invalid BitTorrent info hash', { details: { infoHash: parts.infoHash } });
  }
  let out = `magnet:?xt=urn:btih:${hash}`;
  if (parts.name !== undefined && parts.name !== '') out += `&dn=${encodeURIComponent(parts.name)}`;
  for (const tr of parts.trackers ?? []) out += `&tr=${encodeURIComponent(tr)}`;
  return out;
}
