import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { KotoriError } from '../util/errors';
import { listArchiveImages, readArchiveEntry, readImageSize } from './cbz';

/** Minimal PNG: signature + IHDR (width/height big-endian). */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

/** Minimal JPEG: SOI, an APP0 segment and a DHT segment (to be skipped), then SOF2 (progressive). */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
  const sof = [0xff, 0xc2, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...dht, ...sof, 0xff, 0xd9]);
}

function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([...strToU8('GIF89a'), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0]);
}

/** RIFF/WEBP container with the given first chunk fourcc and payload. */
function webp(fourcc: string, payload: number[]): Uint8Array {
  const b = new Uint8Array(20 + payload.length);
  b.set(strToU8('RIFF'));
  new DataView(b.buffer).setUint32(4, b.length - 8, true);
  b.set(strToU8('WEBP'), 8);
  b.set(strToU8(fourcc), 12);
  new DataView(b.buffer).setUint32(16, payload.length, true);
  b.set(payload, 20);
  return b;
}

const webpLossy = (w: number, h: number): Uint8Array => webp('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, w & 0xff, w >> 8, h & 0xff, h >> 8]);
function webpLossless(w: number, h: number): Uint8Array {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return webp('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
}
function webpExtended(w: number, h: number): Uint8Array {
  const a = w - 1;
  const c = h - 1;
  return webp('VP8X', [0x10, 0, 0, 0, a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff]);
}

const archive = zipSync({
  'Vol 1/': {},
  'Vol 1/p10.jpg': jpeg(1000, 1500),
  'Vol 1/p2.PNG': png(800, 1200),
  'Vol 1/p1.webp': webpLossy(640, 960),
  'Vol 1/extras/cover.gif': gif(300, 400),
  'Vol 1/notes.txt': strToU8('hello'),
  'Vol 1/.hidden.jpg': jpeg(1, 1),
  '__MACOSX/Vol 1/._p10.jpg': strToU8('junk'),
  'Vol 2/p1.jpeg': jpeg(10, 20),
});

describe('listArchiveImages', () => {
  it('lists only images, natural-sorted, skipping __MACOSX/dotfiles/dirs', () => {
    const entries = listArchiveImages(archive);
    expect(entries.map((e) => e.path)).toEqual([
      'Vol 1/extras/cover.gif',
      'Vol 1/p1.webp',
      'Vol 1/p2.PNG',
      'Vol 1/p10.jpg',
      'Vol 2/p1.jpeg',
    ]);
    expect(entries[3]).toEqual({ path: 'Vol 1/p10.jpg', name: 'p10.jpg', size: jpeg(1000, 1500).length });
  });

  it('throws KotoriError(parse) for non-zip data', () => {
    expect(() => listArchiveImages(strToU8('definitely not a zip file'))).toThrow(KotoriError);
  });
});

describe('readArchiveEntry', () => {
  it('extracts one entry by entry object or path', () => {
    const [, , p2] = listArchiveImages(archive);
    expect(readArchiveEntry(archive, p2!)).toEqual(png(800, 1200));
    expect(readArchiveEntry(archive, 'Vol 2/p1.jpeg')).toEqual(jpeg(10, 20));
  });

  it('throws not-found for a missing entry', () => {
    try {
      readArchiveEntry(archive, 'nope.jpg');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KotoriError);
      expect((e as KotoriError).code).toBe('not-found');
    }
  });
});

describe('readImageSize', () => {
  it.each([
    ['PNG', png(800, 1200), 800, 1200],
    ['JPEG (SOF2 after APP0/DHT)', jpeg(1000, 1500), 1000, 1500],
    ['GIF', gif(300, 400), 300, 400],
    ['WebP VP8', webpLossy(640, 960), 640, 960],
    ['WebP VP8L', webpLossless(1654, 2339), 1654, 2339],
    ['WebP VP8X', webpExtended(4000, 6000), 4000, 6000],
  ])('%s', (_label, bytes, width, height) => {
    expect(readImageSize(bytes)).toEqual({ width, height });
  });

  it('reads sizes of images extracted from an archive', () => {
    const sizes = listArchiveImages(archive).map((e) => readImageSize(readArchiveEntry(archive, e)));
    expect(sizes[0]).toEqual({ width: 300, height: 400 });
  });

  it('returns undefined for unknown or truncated data', () => {
    expect(readImageSize(new Uint8Array())).toBeUndefined();
    expect(readImageSize(strToU8('hello world, not an image'))).toBeUndefined();
    expect(readImageSize(jpeg(10, 10).subarray(0, 12))).toBeUndefined();
  });
});
