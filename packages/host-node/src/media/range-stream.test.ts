import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mimeForPath, parseRange, rangeResponse, serveRange } from './range-stream';

describe('parseRange', () => {
  it.each([
    [null, undefined],
    [undefined, undefined],
    ['', undefined],
    ['items=0-1', undefined],
    ['bytes=abc', undefined],
    ['bytes=-', undefined],
    ['bytes=', undefined],
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-2000', { start: 0, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }],
    ['bytes=999-999', { start: 999, end: 999 }],
    ['bytes=0-0, 5-9', { start: 0, end: 0 }],
    ['Bytes = 10 - 19', { start: 10, end: 19 }],
    ['bytes=1000-', 'unsatisfiable'],
    ['bytes=1000-1001', 'unsatisfiable'],
    ['bytes=5-2', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
  ] as const)('%j (size 1000) → %j', (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });

  it('treats any satisfiable-looking range on an empty file as unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-', 0)).toBeUndefined();
  });
});

describe('mimeForPath', () => {
  it.each([
    ['/a/b.MP4', 'video/mp4'],
    ['x.mkv', 'video/x-matroska'],
    ['x.webm', 'video/webm'],
    ['p.JPG', 'image/jpeg'],
    ['s.vtt', 'text/vtt; charset=utf-8'],
    ['s.ass', 'text/plain; charset=utf-8'],
    ['noext', 'application/octet-stream'],
    ['x.bin', 'application/octet-stream'],
  ])('%s → %s', (path, mime) => {
    expect(mimeForPath(path)).toBe(mime);
  });
});

describe('rangeResponse', () => {
  let dir: string;
  let file: string;
  const content = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kotori-range-'));
    file = join(dir, 'video.mp4');
    await writeFile(file, content);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const get = (headers: Record<string, string> = {}, method = 'GET'): Request => new Request('http://localhost/media', { method, headers });
  const body = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());

  it('serves the whole file with 200 when no Range is sent', async () => {
    const res = await rangeResponse(get(), file);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('last-modified')).toMatch(/GMT$/);
    expect(res.headers.has('content-range')).toBe(false);
    expect(await body(res)).toEqual(content);
  });

  it('serves 206 with Content-Range for a bounded range', async () => {
    const res = await rangeResponse(get({ range: 'bytes=10-19' }), file);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(res.headers.get('content-length')).toBe('10');
    expect(await body(res)).toEqual(content.subarray(10, 20));
  });

  it('serves open-ended and suffix ranges', async () => {
    const open = await rangeResponse(get({ range: 'bytes=990-' }), file);
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(await body(open)).toEqual(content.subarray(990));

    const suffix = await rangeResponse(get({ range: 'bytes=-5' }), file);
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 995-999/1000');
    expect(suffix.headers.get('content-length')).toBe('5');
    expect(await body(suffix)).toEqual(content.subarray(995));
  });

  it('answers 416 with bytes */size when unsatisfiable', async () => {
    const res = await rangeResponse(get({ range: 'bytes=5000-' }), file);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.body).toBeNull();
  });

  it('ignores malformed Range headers and serves 200', async () => {
    const res = await rangeResponse(get({ range: 'pages=1-2' }), file);
    expect(res.status).toBe(200);
    expect((await body(res)).length).toBe(1000);
  });

  it('answers HEAD with headers only', async () => {
    const full = await rangeResponse(get({}, 'HEAD'), file);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('1000');
    expect(full.body).toBeNull();

    const partial = await rangeResponse(get({ range: 'bytes=0-99' }, 'HEAD'), file);
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(partial.headers.get('content-length')).toBe('100');
    expect(partial.body).toBeNull();
  });

  it('returns 404 for a missing file or a directory', async () => {
    const missing = await rangeResponse(get(), join(dir, 'missing.mp4'));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Not found');
    expect((await rangeResponse(get(), dir)).status).toBe(404);
  });

  it('serves an empty file as 200 with no body and 416 for any range', async () => {
    const empty = join(dir, 'empty.webm');
    await writeFile(empty, new Uint8Array());
    const res = await rangeResponse(get(), empty);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('0');
    expect(res.headers.get('content-type')).toBe('video/webm');
    expect(res.body).toBeNull();
    const ranged = await rangeResponse(get({ range: 'bytes=0-' }), empty);
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
  });

  it('accepts an explicit mime type', async () => {
    const res = await rangeResponse(get({}, 'HEAD'), file, 'application/x-custom');
    expect(res.headers.get('content-type')).toBe('application/x-custom');
  });

  it('works through the Hono adapter', async () => {
    const app = new Hono();
    app.on(['GET', 'HEAD'], '/v', (c) => serveRange(c, file));
    const res = await app.request('/v', { headers: { range: 'bytes=1-3' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 1-3/1000');
    expect(await body(res)).toEqual(content.subarray(1, 4));
  });
});
