import { describe, expect, it } from 'vitest';
import { KotoriError } from '@kotori/core';
import {
  CLIENT_ONLY_METHODS,
  ROUTES,
  ROUTE_KEYS,
  buildPath,
  buildQuery,
  codeForHttpStatus,
  deserialiseError,
  errorEnvelope,
  httpStatusForCode,
  isApiEnvelope,
  mangaImageUrlFor,
  mediaUrlFor,
  okEnvelope,
  serialiseError,
  type RoutedMethodKey,
  type WireRequest,
} from './index';
import { createRestPlatformHost } from '../client/rest-host';
import { SAMPLE_ARGS } from './sample-args.testutil';

/** Every function-valued member of every PlatformHost group on a real host object. */
function hostMethodKeys(): string[] {
  const host = createRestPlatformHost({ baseUrl: 'http://x', fetch: async () => new Response('{}') });
  const keys: string[] = [];
  for (const group of ['settings', 'anime', 'manga', 'ai', 'downloads', 'files'] as const) {
    for (const [name, value] of Object.entries(host[group])) if (typeof value === 'function') keys.push(`${group}.${name}`);
  }
  return keys.sort();
}

describe('route table', () => {
  it('covers every PlatformHost method exactly once (client-only pickers excluded)', () => {
    const routed = new Set<string>(ROUTE_KEYS);
    const clientOnly = new Set<string>(CLIENT_ONLY_METHODS);
    for (const key of hostMethodKeys()) expect(routed.has(key) || clientOnly.has(key), key).toBe(true);
    // 51 routed methods = 3 settings + 15 anime + 10 manga + 9 ai + 12 downloads + 2 files.
    expect(ROUTE_KEYS).toHaveLength(51);
    for (const key of ROUTE_KEYS) expect(hostMethodKeys()).toContain(key);
  });

  it('has unique method+path pairs and API-prefixed paths', () => {
    const seen = new Set<string>();
    for (const key of ROUTE_KEYS) {
      const { method, path } = ROUTES[key];
      expect(path.startsWith('/api/'), key).toBe(true);
      const id = `${method} ${path}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
  });

  it('round-trips sample args through encode → (JSON) → decode for every route', () => {
    for (const key of ROUTE_KEYS) {
      const args = SAMPLE_ARGS[key];
      expect(args, `sample args for ${key}`).toBeDefined();
      const route = ROUTES[key] as unknown as { encode: (...a: unknown[]) => WireRequest; decode: (w: WireRequest) => unknown[] };
      const wire = route.encode(...args);
      // Simulate the transport: path params survive as strings, body as JSON.
      const transported: WireRequest = JSON.parse(JSON.stringify(wire)) as WireRequest;
      expect(() => buildPath(ROUTES[key].path, wire.params), key).not.toThrow();
      const decoded = route.decode(transported);
      expect(decoded, key).toEqual(args);
    }
  });

  it('decode rejects malformed integers', () => {
    expect(() => ROUTES['manga.getPage'].decode({ params: { volumeId: 'v', pageIndex: 'abc' }, query: {} })).toThrow(/integer/);
  });

  it('maps optional arguments to query flags', () => {
    expect(ROUTES['anime.removeSeries'].encode('s1', true).query).toEqual({ deleteFiles: '1' });
    expect(ROUTES['anime.removeSeries'].encode('s1').query).toEqual({});
    expect(ROUTES['downloads.listJimakuFiles'].encode(3, 7).query).toEqual({ episode: '7' });
    expect(ROUTES['manga.setReadingMode'].encode('v', undefined).body).toEqual({ mode: null });
  });
});

describe('path helpers', () => {
  it('encodes params and queries', () => {
    expect(buildPath('/api/anime/series/:seriesId', { seriesId: 'a b/c' })).toBe('/api/anime/series/a%20b%2Fc');
    expect(() => buildPath('/api/x/:id', {})).toThrow(/missing/);
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ url: 'https://a/b?c=1' })).toBe('?url=https%3A%2F%2Fa%2Fb%3Fc%3D1');
    expect(mediaUrlFor('ep_1')).toBe('/media/ep_1');
    expect(mangaImageUrlFor('mv 1', 3)).toBe('/api/manga/volumes/mv%201/pages/3/image');
  });
});

describe('wire envelope', () => {
  it('maps error codes to HTTP statuses and back', () => {
    expect(httpStatusForCode('not-found')).toBe(404);
    expect(httpStatusForCode('invalid-argument')).toBe(400);
    expect(httpStatusForCode('unsupported')).toBe(501);
    expect(httpStatusForCode('ai-auth')).toBe(401);
    expect(httpStatusForCode('ai-quota')).toBe(429);
    expect(httpStatusForCode('io')).toBe(500);
    expect(codeForHttpStatus(404)).toBe('not-found');
    expect(codeForHttpStatus(429)).toBe('ai-quota');
    expect(codeForHttpStatus(500)).toBe('internal');
  });

  it('serialises KotoriError, shape-likes, Errors and unknowns', () => {
    const e = new KotoriError('ai-quota', 'slow down', { details: { retryAfterMs: 1000 } });
    expect(serialiseError(e)).toEqual({ code: 'ai-quota', message: 'slow down', details: { retryAfterMs: 1000 } });
    expect(serialiseError({ code: 'not-found', message: 'x' })).toEqual({ code: 'not-found', message: 'x' });
    expect(serialiseError(new Error('boom'))).toEqual({ code: 'internal', message: 'boom' });
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(serialiseError(abort).code).toBe('cancelled');
    expect(serialiseError(42)).toEqual({ code: 'internal', message: '42' });
    const back = deserialiseError(serialiseError(e));
    expect(back).toBeInstanceOf(KotoriError);
    expect(back.code).toBe('ai-quota');
    expect(back.details).toEqual({ retryAfterMs: 1000 });
  });

  it('builds and recognises envelopes', () => {
    expect(okEnvelope(1)).toEqual({ ok: true, data: 1 });
    expect(errorEnvelope(new KotoriError('io', 'disk'))).toEqual({ ok: false, error: { code: 'io', message: 'disk' } });
    expect(isApiEnvelope({ ok: true, data: null })).toBe(true);
    expect(isApiEnvelope({ ok: false, error: { code: 'io', message: 'x' } })).toBe(true);
    expect(isApiEnvelope({ ok: false, error: { code: 'nope', message: 'x' } })).toBe(false);
    expect(isApiEnvelope({ data: 1 })).toBe(false);
  });
});

/** Compile-time: SAMPLE_ARGS keys are exactly the routed keys. */
const _keysCheck: Record<RoutedMethodKey, unknown> = SAMPLE_ARGS;
void _keysCheck;
