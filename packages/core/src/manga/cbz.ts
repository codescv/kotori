/**
 * CBZ / ZIP page listing + extraction and image-header size sniffing.
 * Built on `fflate.unzipSync` with a filter so listing never inflates data and
 * extraction inflates exactly one entry.
 */
import { unzipSync } from 'fflate';
import { KotoriError } from '../util/errors';
import { compareNatural } from '../util/natural-sort';

/** One page image inside an archive. */
export interface ArchiveImageEntry {
  /** Full forward-slash path inside the archive (e.g. `vol1/p001.jpg`). */
  readonly path: string;
  /** Basename of {@link path}. */
  readonly name: string;
  /** Uncompressed size in bytes as recorded in the archive directory. */
  readonly size: number;
}

/** Lower-case extensions treated as page images. */
export const ARCHIVE_IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'jxl'];

/** True for archive paths that are page images (not dirs, `__MACOSX`, dotfiles / AppleDouble). */
function isImagePath(path: string): boolean {
  if (path.endsWith('/')) return false;
  const parts = path.split('/');
  if (parts.some((p) => p === '__MACOSX' || p.startsWith('.'))) return false;
  const name = parts[parts.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && ARCHIVE_IMAGE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** Wrap fflate failures (corrupt / non-zip data) as `KotoriError('parse')`. */
function unzip(bytes: Uint8Array, filter: (file: { name: string; originalSize: number }) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, { filter });
  } catch (e) {
    throw new KotoriError('parse', `Invalid ZIP/CBZ archive: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/**
 * List page images in a ZIP/CBZ, natural-sorted by full path (so `p2 < p10` and
 * nested chapter folders stay grouped). Skips directories, `__MACOSX/`,
 * dotfiles and non-image entries. No entry data is inflated.
 * @throws KotoriError `parse` when `bytes` is not a readable ZIP.
 */
export function listArchiveImages(bytes: Uint8Array): ArchiveImageEntry[] {
  const out: ArchiveImageEntry[] = [];
  unzip(bytes, (file) => {
    const path = file.name.replace(/\\/g, '/');
    if (isImagePath(path)) out.push({ path, name: path.slice(path.lastIndexOf('/') + 1), size: file.originalSize });
    return false;
  });
  return out.sort((a, b) => compareNatural(a.path, b.path));
}

/**
 * Inflate a single archive entry (an {@link ArchiveImageEntry} or a raw path).
 * @throws KotoriError `not-found` when the entry is absent, `parse` on a bad archive.
 */
export function readArchiveEntry(bytes: Uint8Array, entry: ArchiveImageEntry | string): Uint8Array {
  const path = typeof entry === 'string' ? entry : entry.path;
  let foundName: string | undefined;
  const files = unzip(bytes, (file) => {
    if (foundName === undefined && file.name.replace(/\\/g, '/') === path) {
      foundName = file.name;
      return true;
    }
    return false;
  });
  const data = foundName === undefined ? undefined : files[foundName];
  if (!data) throw new KotoriError('not-found', `Archive entry not found: ${path}`, { details: { path } });
  return data;
}

const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number): number => (((b[o] ?? 0) << 24) >>> 0) + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

/**
 * Walk JPEG markers until a Start-Of-Frame segment and read its dimensions.
 * SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry `height, width`.
 */
function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let o = 2;
  while (o + 3 < b.length) {
    if (b[o] !== 0xff) return undefined;
    const marker = b[o + 1] ?? 0;
    if (marker === 0xff) {
      o++; // fill byte
      continue;
    }
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI / SOS before any SOF
    const len = u16be(b, o + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (o + 9 > b.length) return undefined;
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    if (len < 2) return undefined;
    o += 2 + len;
  }
  return undefined;
}

/** Parse the RIFF/WEBP first chunk: lossy `VP8 `, lossless `VP8L` or extended `VP8X`. */
function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return undefined;
    // 14 bits width-1, then 14 bits height-1, little-endian bit order.
    const bits = ((b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return undefined;
}

/**
 * Sniff pixel dimensions from an image header (JPEG, PNG, WebP VP8/VP8L/VP8X,
 * GIF). Returns `undefined` for unknown or truncated data. EXIF orientation is
 * not applied (dimensions are as stored).
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return { width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webpSize(b);
  return undefined;
}
