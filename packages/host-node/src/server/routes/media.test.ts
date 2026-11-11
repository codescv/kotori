import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KotoriError } from '@kotori/core';
import type { CompatRemuxer } from '../../media/compat-remux';
import type { ServerContext } from '../context';
import { mountMediaRoutes } from './media';

const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('GET|HEAD /media/:episodeId compat remux', () => {
  let dir: string;
  let files: Record<string, string>;
  let remuxed: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kotori-media-route-'));
    files = { mkv: join(dir, 'ep.mkv'), mp4: join(dir, 'ep.mp4'), webm: join(dir, 'ep.webm') };
    await writeFile(files['mkv']!, 'MKV-ORIGINAL');
    await writeFile(files['mp4']!, 'MP4-ORIGINAL');
    await writeFile(files['webm']!, 'WEBM-ORIGINAL');
    remuxed = join(dir, 'cached.mp4');
    await writeFile(remuxed, 'REMUXED-MP4-0123456789');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(remuxer: CompatRemuxer): Hono {
    const ctx = {
      ffmpeg: undefined,
      host: {
        anime: {
          mediaPath: (id: string) => {
            const path = files[id];
            if (!path) throw new KotoriError('not-found', `episode ${id}`);
            return path;
          },
        },
      },
    } as unknown as Pick<ServerContext, 'host' | 'ffmpeg'>;
    const app = new Hono();
    mountMediaRoutes(app, ctx, { remuxer });
    return app;
  }

  function fakeRemuxer(result: () => string | undefined, available = true): CompatRemuxer & { remux: ReturnType<typeof vi.fn> } {
    return { available: () => available, remux: vi.fn(async () => result()) };
  }

  it('serves the cached MP4 to Safari/iOS for .mkv, with Range support', async () => {
    const remuxer = fakeRemuxer(() => remuxed);
    const app = setup(remuxer);
    const res = await app.request('/media/mkv', { headers: { 'user-agent': SAFARI_IOS } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(await res.text()).toBe('REMUXED-MP4-0123456789');
    expect(remuxer.remux).toHaveBeenCalledWith(files['mkv']);

    const partial = await app.request('/media/mkv', { headers: { 'user-agent': SAFARI_IOS, range: 'bytes=0-6' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 0-6/22');
    expect(await partial.text()).toBe('REMUXED');

    const head = await app.request('/media/mkv', { method: 'HEAD', headers: { 'user-agent': SAFARI_IOS } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('video/mp4');
    expect(head.headers.get('content-length')).toBe('22');
  });

  it('serves the original file to Chromium and for Apple-compatible containers', async () => {
    const remuxer = fakeRemuxer(() => remuxed);
    const app = setup(remuxer);
    const chrome = await app.request('/media/mkv', { headers: { 'user-agent': CHROME } });
    expect(chrome.headers.get('content-type')).toBe('video/x-matroska');
    expect(await chrome.text()).toBe('MKV-ORIGINAL');
    const safariMp4 = await app.request('/media/mp4', { headers: { 'user-agent': SAFARI_IOS } });
    expect(await safariMp4.text()).toBe('MP4-ORIGINAL');
    expect(remuxer.remux).not.toHaveBeenCalled();
  });

  it('honours ?compat=1 for any browser and container', async () => {
    const remuxer = fakeRemuxer(() => remuxed);
    const app = setup(remuxer);
    const res = await app.request('/media/webm?compat=1', { headers: { 'user-agent': CHROME } });
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(await res.text()).toBe('REMUXED-MP4-0123456789');
    expect(remuxer.remux).toHaveBeenCalledWith(files['webm']);
  });

  it('falls back to the original bytes when ffmpeg is unavailable or the remux fails', async () => {
    const unavailable = fakeRemuxer(() => remuxed, false);
    const res = await setup(unavailable).request('/media/mkv?compat=1', { headers: { 'user-agent': SAFARI_IOS } });
    expect(res.headers.get('content-type')).toBe('video/x-matroska');
    expect(await res.text()).toBe('MKV-ORIGINAL');
    expect(unavailable.remux).not.toHaveBeenCalled();

    const failing = fakeRemuxer(() => undefined);
    const res2 = await setup(failing).request('/media/mkv', { headers: { 'user-agent': SAFARI_IOS } });
    expect(res2.headers.get('content-type')).toBe('video/x-matroska');
    expect(await res2.text()).toBe('MKV-ORIGINAL');
    expect(failing.remux).toHaveBeenCalledTimes(1);
  });

  it('still 404s unknown episodes', async () => {
    const remuxer = fakeRemuxer(() => remuxed);
    const res = await setup(remuxer).request('/media/nope?compat=1', { headers: { 'user-agent': SAFARI_IOS } });
    expect(res.status).toBe(404);
    expect(remuxer.remux).not.toHaveBeenCalled();
  });

  it('defaults to an ffmpeg-backed remuxer that is a no-op without ffmpeg', async () => {
    const ctx = { ffmpeg: undefined, host: { anime: { mediaPath: () => files['mkv']! } } } as unknown as Pick<ServerContext, 'host' | 'ffmpeg'>;
    const app = new Hono();
    mountMediaRoutes(app, ctx);
    const res = await app.request('/media/mkv?compat=1', { headers: { 'user-agent': SAFARI_IOS } });
    expect(res.headers.get('content-type')).toBe('video/x-matroska');
  });
});
