import { describe, expect, it } from 'vitest';
import { buildMagnet, normaliseInfoHash, parseMagnet } from './magnet';
import { KotoriError } from '../util/errors';

const HEX = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
// Same hash in RFC 4648 base32.
const B32 = 'YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK';

describe('normaliseInfoHash', () => {
  it('lower-cases hex and decodes base32', () => {
    expect(normaliseInfoHash(HEX.toUpperCase())).toBe(HEX);
    expect(normaliseInfoHash(B32)).toBe(HEX);
    expect(normaliseInfoHash(B32.toLowerCase())).toBe(HEX);
    expect(normaliseInfoHash('xyz')).toBeUndefined();
    expect(normaliseInfoHash('g'.repeat(40))).toBeUndefined();
  });
});

describe('parseMagnet', () => {
  it('parses hex btih, name and trackers (deduplicated, tr.N supported)', () => {
    const m = parseMagnet(
      `magnet:?xt=urn:btih:${HEX.toUpperCase()}&dn=%5BGroup%5D+Title+-+01.mkv&tr=udp%3A%2F%2Fa%3A1%2Fannounce&tr.1=http%3A%2F%2Fb%2Fannounce&tr=udp%3A%2F%2Fa%3A1%2Fannounce`,
    );
    expect(m).toEqual({
      infoHash: HEX,
      name: '[Group] Title - 01.mkv',
      trackers: ['udp://a:1/announce', 'http://b/announce'],
    });
  });

  it('parses base32 btih and omits a missing name', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${B32}`);
    expect(m).toEqual({ infoHash: HEX, trackers: [] });
    expect('name' in m).toBe(false);
  });

  it('throws invalid-argument for non-magnets and missing hashes', () => {
    expect(() => parseMagnet('https://nyaa.si')).toThrow(KotoriError);
    try {
      parseMagnet('magnet:?dn=foo');
      expect.unreachable();
    } catch (e) {
      expect((e as KotoriError).code).toBe('invalid-argument');
    }
  });
});

describe('buildMagnet', () => {
  it('round-trips through parseMagnet with full percent-encoding', () => {
    const uri = buildMagnet({ infoHash: B32, name: '葬送のフリーレン & 01', trackers: ['udp://t:1/announce'] });
    expect(uri).toBe(
      `magnet:?xt=urn:btih:${HEX}&dn=${encodeURIComponent('葬送のフリーレン & 01')}&tr=udp%3A%2F%2Ft%3A1%2Fannounce`,
    );
    expect(parseMagnet(uri)).toEqual({ infoHash: HEX, name: '葬送のフリーレン & 01', trackers: ['udp://t:1/announce'] });
  });

  it('rejects invalid hashes', () => {
    expect(() => buildMagnet({ infoHash: 'nope' })).toThrow(/info hash/);
  });
});
