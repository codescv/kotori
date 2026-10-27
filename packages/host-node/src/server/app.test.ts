/**
 * In-process integration tests: the real `RestPlatformHost` talks to the real
 * Hono app (`app.request` as `fetch`) backed by a temp-dir SQLite database.
 * Covers every route in the table plus the anime / manga / AI / downloads /
 * events / media / static flows end-to-end.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpDelta, HostEvent, PlatformHost } from '@kotori/core';
import { ROUTE_KEYS, type RoutedMethodKey } from '../shared';
import { SAMPLE_ARGS } from '../shared/sample-args.testutil';
import { createRestPlatformHost } from '../client/rest-host';
import { createApp } from './app';
import { createServerContext, type ServerContext } from './context';
import { startServer } from './start';
import type { TorrentEngine } from '../downloads/torrent-engine';

const FIXTURES = new URL('../../test-fixtures/', import.meta.url);
const geminiFixture = JSON.parse(readFileSync(new URL('ai/gemini-standard.json', FIXTURES), 'utf8')) as { sentence: string; raw: unknown };

/** 1×1 PNG with a 4×6 IHDR so size sniffing returns 4×6. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

const SRT = '1\n00:00:01,000 --> 00:00:02,500\n今日は学校に行きたくない。\n\n2\n00:00:03,000 --> 00:00:04,000\nなんで？\n';
const ASS = `[Script Info]
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}こんにちは\\N世界
`;

function geminiJson(text: string): Response {
  return Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    modelVersion: 'gemini-2.5-flash',
  });
}

interface Harness {
  dir: string;
  ctx: ServerContext;
  app: ReturnType<typeof createApp>;
  host: PlatformHost;
  events: HostEvent[];
  fetchLog: string[];
  opener: ReturnType<typeof vi.fn>;
  geminiCalls: () => number;
}

async function harness(options: { webDir?: string } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'kotori-app-'));
  const fetchLog: string[] = [];
  let gemini = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(url);
    if (url.includes('generativelanguage.googleapis.com')) {
      gemini += 1;
      const body = typeof init?.body === 'string' ? init.body : '';
      if (url.includes('streamGenerateContent')) {
        const chunks = ['こん', 'にちは'].map((t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`);
        return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (body.includes('responseSchema')) return geminiJson(JSON.stringify(geminiFixture.raw));
      return geminiJson('OK');
    }
    if (url.startsWith('https://nyaa.si/')) {
      return new Response(
        `<rss><channel><item><title>[Grp] Show - 01 (1080p).mkv</title><link>https://nyaa.si/download/1.torrent</link><guid>https://nyaa.si/view/1</guid><pubDate>Mon, 01 Jan 2024 00:00:00 -0000</pubDate><nyaa:seeders>12</nyaa:seeders><nyaa:leechers>1</nyaa:leechers><nyaa:downloads>100</nyaa:downloads><nyaa:infoHash>0123456789abcdef0123456789abcdef01234567</nyaa:infoHash><nyaa:categoryId>1_4</nyaa:categoryId><nyaa:size>1.0 GiB</nyaa:size><nyaa:trusted>Yes</nyaa:trusted><nyaa:remake>No</nyaa:remake></item></channel></rss>`,
      );
    }
    if (url.startsWith('https://mokuro.moe/')) {
      return new Response('<html><body><pre><a href="../">../</a>\n<a href="Vol1.mokuro">Vol1.mokuro</a>  01-Jan-2024 10:00  1234\n<a href="Vol1.zip">Vol1.zip</a>  01-Jan-2024 10:00  99999\n</pre></body></html>');
    }
    if (url.startsWith('https://jimaku.cc/')) return Response.json([]);
    if (url.startsWith('https://example.com/')) return new Response(new Uint8Array(4096).fill(7), { headers: { 'content-length': '4096' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const opener = vi.fn(async () => undefined);
  const fakeEngine: TorrentEngine = {
    add: async () => {
      throw new Error('torrent engine disabled in this test');
    },
    get: () => undefined,
    remove: async () => undefined,
    destroy: async () => undefined,
  };
  const ctx = await createServerContext(
    { host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), openBrowser: false, ...(options.webDir ? { webDir: options.webDir } : {}) },
    { fetch: fakeFetch, ffmpeg: null, adc: async () => 'adc-token', opener, home: dir, torrentEngine: () => fakeEngine },
  );
  const app = createApp(ctx);
  const events: HostEvent[] = [];
  ctx.events.subscribe((e) => events.push(e));
  const host = createRestPlatformHost({ baseUrl: 'http://127.0.0.1:7865', fetch: async (url, init) => app.request(url, init) });
  return { dir, ctx, app, host, events, fetchLog, opener, geminiCalls: () => gemini };
}

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.host.dispose();
  await h.ctx.close();
  await rm(h.dir, { recursive: true, force: true });
});

function invoke(host: PlatformHost, key: RoutedMethodKey, args: readonly unknown[]): Promise<unknown> {
  const [group, method] = key.split('.') as [keyof PlatformHost, string];
  const target = host[group] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const fn = target[method] as (...a: unknown[]) => Promise<unknown>;
  return key === 'ai.followUpStream' ? fn(args[0], () => undefined) : fn(...args);
}

describe('REST route coverage', () => {
  it('every route-table entry is mounted and dispatches to the server host', async () => {
    const missing: string[] = [];
    for (const key of ROUTE_KEYS) {
      try {
        await invoke(h.host, key, SAMPLE_ARGS[key] as readonly unknown[]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Domain errors (not-found ids, unsupported ffmpeg, …) are fine; routing gaps are not.
        if (/^No route|not implemented by this host|HTTP 404$/.test(message)) missing.push(`${key}: ${message}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('serves host info with desktop capabilities', async () => {
    const res = await h.app.request('/api/info');
    const body = (await res.json()) as { ok: boolean; data: { platform: string; capabilities: Record<string, boolean> } };
    expect(body.ok).toBe(true);
    expect(body.data.platform).toBe('node');
    expect(body.data.capabilities).toMatchObject({ torrent: true, pathBrowser: true, embeddedSubtitles: false, vertexAdc: true, streaming: true });
  });

  it('returns JSON error envelopes with mapped statuses', async () => {
    const missing = await h.app.request('/api/anime/series/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'not-found' } });
    const unknown = await h.app.request('/api/does-not-exist');
    expect(unknown.status).toBe(404);
    const bad = await h.app.request('/api/settings', { method: 'PATCH', body: '{not json', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    const invalid = await h.app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ ai: { temperature: 9 } }), headers: { 'content-type': 'application/json' } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid-argument', details: { field: 'ai.temperature' } } });
    const unsupported = await h.app.request('/api/anime/episodes/x/embedded/1', { method: 'POST' });
    expect([404, 501]).toContain(unsupported.status);
  });
});

describe('local-only guard (CSRF / DNS rebinding)', () => {
  it('rejects foreign Host headers, including reads', async () => {
    const res = await h.app.request('http://evil.example:7865/api/settings');
    expect(res.status).toBe(403);
    const rebind = await h.app.request('/api/settings', { headers: { host: 'evil.example:7865' } });
    expect(rebind.status).toBe(403);
    for (const ok of ['http://127.0.0.1:7865/api/info', 'http://localhost:5173/api/info', 'http://[::1]:7865/api/info']) {
      expect((await h.app.request(ok)).status, ok).toBe(200);
    }
  });

  it('rejects cross-origin writes and non-JSON bodies', async () => {
    const body = JSON.stringify({ path: join(h.dir, 'nope') });
    const crossOrigin = await h.app.request('http://127.0.0.1:7865/api/manga/volumes', {
      method: 'POST',
      body,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    });
    expect(crossOrigin.status).toBe(403);
    const textPlain = await h.app.request('http://127.0.0.1:7865/api/manga/volumes', { method: 'POST', body, headers: { 'content-type': 'text/plain' } });
    expect(textPlain.status).toBe(415);
    const form = await h.app.request('http://127.0.0.1:7865/api/files/open-external', {
      method: 'POST',
      body: 'url=https%3A%2F%2Fx',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBe(415);
    const noBodyCross = await h.app.request('http://127.0.0.1:7865/api/downloads/x/cancel', { method: 'POST', headers: { origin: 'null' } });
    expect(noBodyCross.status).toBe(403);
    expect(h.opener).not.toHaveBeenCalled();
    const sameOrigin = await h.app.request('http://127.0.0.1:7865/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ ui: { theme: 'dark' } }),
      headers: { origin: 'http://127.0.0.1:7865', 'content-type': 'application/json' },
    });
    expect(sameOrigin.status).toBe(200);
    const noBody = await h.app.request('http://127.0.0.1:7865/api/downloads/x/cancel', { method: 'POST' });
    expect(noBody.status).toBe(404); // reaches the handler (unknown task), not blocked
  });
});

describe('settings', () => {
  it('persists patches and emits settings-changed', async () => {
    const before = await h.host.settings.get();
    expect(before.ai.explainModel).toBe('gemini-3.5-flash-lite');
    const after = await h.host.settings.update({ ui: { theme: 'dark' }, ai: { provider: { provider: 'vertex-ai', location: 'global', project: 'p', auth: { kind: 'adc' } } } });
    expect(after.ui.theme).toBe('dark');
    expect(after.ai.provider).toEqual({ provider: 'vertex-ai', location: 'global', project: 'p', auth: { kind: 'adc' } });
    expect(h.events.some((e) => e.type === 'settings-changed')).toBe(true);
    expect((await h.host.settings.get()).ui.theme).toBe('dark');
  });

  it('testAi round-trips through the configured provider', async () => {
    await h.host.settings.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'k' } } });
    const result = await h.host.settings.testAi();
    expect(result).toMatchObject({ ok: true, message: 'OK' });
    const failing = await h.host.settings.testAi({
      ...(await h.host.settings.get()).ai,
      provider: { provider: 'vertex-ai', location: 'us-central1', project: 'p', auth: { kind: 'access-token', accessToken: '' } },
    });
    expect(failing.ok).toBe(false);
  });
});

describe('anime library', () => {
  async function makeShow(): Promise<string> {
    const show = join(h.dir, 'Show');
    await mkdir(join(show, 'extras'), { recursive: true });
    await writeFile(join(show, '[Grp] Show - 01 (1080p).mp4'), new Uint8Array(10_000).map((_, i) => i % 251));
    await writeFile(join(show, '[Grp] Show - 01 (1080p).ja.srt'), SRT);
    await writeFile(join(show, '[Grp] Show - 02 (1080p).mkv'), new Uint8Array(2048));
    await writeFile(join(show, 'notes.txt'), 'x');
    return show;
  }

  it('imports a folder, matches sidecars, parses cues with delay and tracks progress', async () => {
    const show = await makeShow();
    const series = await h.host.anime.importSeries({ path: show });
    expect(series.title).toBe('Show');
    expect(series.episodeCount).toBe(2);
    expect(h.events).toContainEqual({ type: 'library-changed', scope: 'anime' });
    const episodes = await h.host.anime.listEpisodes(series.id);
    expect(episodes.map((e) => e.parsedName.episode)).toEqual([1, 2]);
    const [ep1, ep2] = episodes;
    if (!ep1 || !ep2) throw new Error('episodes missing');
    expect(ep1.container).toBe('mp4');
    expect(ep2.container).toBe('mkv');
    expect(ep1.mediaUrl).toBe(`/media/${ep1.id}`);
    expect(ep1.subtitleTracks).toHaveLength(1);
    const track = ep1.subtitleTracks[0];
    if (!track) throw new Error('track missing');
    expect(track).toMatchObject({ origin: 'external', format: 'srt', language: 'ja', isDefault: true, delayMs: 0 });

    const cues = await h.host.anime.getCues(track.id);
    expect(cues.cues.map((c) => c.text)).toEqual(['今日は学校に行きたくない。', 'なんで？']);
    expect(cues.cues[0]).toMatchObject({ startMs: 1000, endMs: 2500 });
    await h.host.anime.setTrackDelay(track.id, 500);
    expect((await h.host.anime.getCues(track.id)).cues[0]).toMatchObject({ startMs: 1500, endMs: 3000 });
    expect((await h.host.anime.getEpisode(ep1.id)).subtitleTracks[0]?.cueCount).toBe(2);

    const imported = await h.host.anime.addSubtitleTrack(ep1.id, { content: ASS, fileName: 'my.ass' });
    expect(imported).toMatchObject({ origin: 'imported', format: 'ass', isDefault: false });
    const assCues = await h.host.anime.getCues(imported.id);
    expect(assCues.cues[0]?.text).toBe('こんにちは\n世界');
    await h.host.anime.setDefaultTrack(ep1.id, imported.id);
    const refreshed = await h.host.anime.getEpisode(ep1.id);
    expect(refreshed.subtitleTracks.find((t) => t.isDefault)?.id).toBe(imported.id);
    await expect(h.host.anime.setDefaultTrack(ep2.id, imported.id)).rejects.toMatchObject({ code: 'invalid-argument' });
    await h.host.anime.removeSubtitleTrack(imported.id);
    await expect(h.host.anime.getCues(imported.id)).rejects.toMatchObject({ code: 'not-found' });

    await h.host.anime.saveProgress(ep2.id, { positionMs: 60_000, durationMs: 1_440_000, updatedAt: 1_700_000_000_000 });
    expect((await h.host.anime.getEpisode(ep2.id)).progress).toEqual({ positionMs: 60_000, durationMs: 1_440_000, updatedAt: 1_700_000_000_000 });
    expect((await h.host.anime.getSeries(series.id)).lastWatchedEpisodeId).toBe(ep2.id);

    await expect(h.host.anime.extractEmbeddedTrack(ep2.id, 2)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(h.host.anime.addSubtitleTrack(ep1.id, { content: 'garbage', fileName: 'x.srt' })).rejects.toMatchObject({ code: 'parse' });
  });

  it('streams media with HTTP Range and correct MIME types', async () => {
    const series = await h.host.anime.importSeries({ path: await makeShow() });
    const [ep1, ep2] = await h.host.anime.listEpisodes(series.id);
    if (!ep1 || !ep2) throw new Error('episodes missing');
    const partial = await h.app.request(ep1.mediaUrl, { headers: { range: 'bytes=100-199' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-type')).toBe('video/mp4');
    expect(partial.headers.get('accept-ranges')).toBe('bytes');
    expect(partial.headers.get('content-range')).toBe('bytes 100-199/10000');
    const bytes = new Uint8Array(await partial.arrayBuffer());
    expect(bytes.length).toBe(100);
    expect(bytes[0]).toBe(100 % 251);
    const head = await h.app.request(ep2.mediaUrl, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('video/x-matroska');
    expect(head.headers.get('content-length')).toBe('2048');
    const bad = await h.app.request(ep1.mediaUrl, { headers: { range: 'bytes=99999-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */10000');
    expect((await h.app.request('/media/unknown')).status).toBe(404);
  });

  it('rescans new episodes, accepts multipart subtitle uploads and removes series', async () => {
    const show = await makeShow();
    const series = await h.host.anime.importSeries({ path: show });
    await writeFile(join(show, '[Grp] Show - 03 (1080p).webm'), new Uint8Array(10));
    const rescanned = await h.host.anime.rescanSeries(series.id);
    expect(rescanned.episodeCount).toBe(3);
    const episodes = await h.host.anime.listEpisodes(series.id);
    const ep3 = episodes[2];
    if (!ep3) throw new Error('ep3 missing');
    expect(ep3.container).toBe('webm');

    const form = new FormData();
    form.set('file', new File([new TextEncoder().encode(SRT)], 'upload.ja.srt'));
    const res = await h.app.request(`/api/anime/episodes/${ep3.id}/tracks`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { origin: string; language?: string; cueCount?: number; isDefault: boolean } };
    expect(body.data).toMatchObject({ origin: 'imported', language: 'ja', cueCount: 2, isDefault: true });

    await h.host.anime.removeSeries(series.id);
    expect(await h.host.anime.listSeries()).toEqual([]);
    await expect(h.host.anime.getEpisode(ep3.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(h.host.anime.importSeries({ path: 'relative/path' })).rejects.toMatchObject({ code: 'invalid-argument' });
    const empty = join(h.dir, 'empty');
    await mkdir(empty);
    await expect(h.host.anime.importSeries({ path: empty })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('manga library', () => {
  async function makeMokuro(): Promise<string> {
    const root = join(h.dir, 'manga');
    await mkdir(join(root, 'Vol1'), { recursive: true });
    await writeFile(join(root, 'Vol1', '001.png'), png(800, 1200));
    await writeFile(join(root, 'Vol1', '002.png'), png(800, 1200));
    const mokuro = {
      version: '0.2.1',
      title: 'Yotsuba',
      volume: 'Vol1',
      pages: [
        { img_path: '001.png', img_width: 800, img_height: 1200, blocks: [{ box: [10, 20, 110, 220], vertical: true, font_size: 30, lines: ['よつばと', '！'], lines_coords: [] }] },
        { img_path: '002.png', img_width: 0, img_height: 0, blocks: [] },
      ],
    };
    await writeFile(join(root, 'Vol1.mokuro'), JSON.stringify(mokuro));
    return join(root, 'Vol1.mokuro');
  }

  it('imports .mokuro with a same-named image folder and serves pages', async () => {
    const volume = await h.host.manga.importVolume({ path: await makeMokuro() });
    expect(volume).toMatchObject({ kind: 'mokuro', hasOcr: true, pageCount: 2, coverIsSingle: true, seriesTitle: 'Yotsuba' });
    expect(h.events).toContainEqual({ type: 'library-changed', scope: 'manga' });
    const pages = await h.host.manga.getPages(volume.id);
    expect(pages[0]?.blocks[0]).toMatchObject({ text: 'よつばと！', vertical: true, rect: { left: 10, top: 20, right: 110, bottom: 220 } });
    expect(pages[1]).toMatchObject({ width: 800, height: 1200 }); // sniffed from PNG header
    const img = await h.app.request(pages[0]?.imageUrl ?? '');
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png(800, 1200));

    expect((await h.host.manga.setReadingMode(volume.id, 'webtoon')).readingMode).toBe('webtoon');
    expect((await h.host.manga.setReadingMode(volume.id, undefined)).readingMode).toBeUndefined();
    expect((await h.host.manga.setCoverIsSingle(volume.id, false)).coverIsSingle).toBe(false);
    await h.host.manga.saveProgress(volume.id, { pageIndex: 1, updatedAt: 5 });
    expect((await h.host.manga.getVolume(volume.id)).progress).toEqual({ pageIndex: 1, updatedAt: 5 });
    await expect(h.host.manga.saveProgress(volume.id, { pageIndex: 9, updatedAt: 5 })).rejects.toMatchObject({ code: 'invalid-argument' });

    const page = await h.host.manga.addBlocks(volume.id, 1, [
      { rect: { left: 0, top: 0, right: 50, bottom: 50 }, vertical: false, fontSize: 12, zIndex: 0, lines: ['VLM'], text: 'VLM', source: 'vlm' },
    ]);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]).toMatchObject({ index: 0, source: 'vlm', text: 'VLM' });
    await expect(h.host.manga.getPage(volume.id, 7)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('imports a .cbz into a managed directory and deletes it on removal', async () => {
    const cbz = join(h.dir, 'Series v02.cbz');
    await writeFile(
      cbz,
      zipSync({ 'p10.png': png(10, 20), 'p2.png': png(30, 40), '__MACOSX/._p2.png': new Uint8Array(4), 'readme.txt': new TextEncoder().encode('hi') }),
    );
    const volume = await h.host.manga.importVolume({ path: cbz });
    expect(volume).toMatchObject({ kind: 'images', hasOcr: false, pageCount: 2, volumeNumber: 2 });
    const pages = await h.host.manga.getPages(volume.id);
    expect(pages.map((p) => p.relativePath)).toEqual(['p2.png', 'p10.png']);
    expect(pages[0]).toMatchObject({ width: 30, height: 40 });
    const managed = join(h.ctx.info.dataDir, 'manga', volume.id);
    expect(await readdir(managed)).toEqual(expect.arrayContaining(['p2.png', 'p10.png']));
    await h.host.manga.removeVolume(volume.id);
    await expect(readdir(managed)).rejects.toThrow();
    expect(await h.host.manga.listVolumes()).toEqual([]);
  });
});

describe('AI', () => {
  const request = () => ({ sentence: geminiFixture.sentence, source: { kind: 'manual' as const }, targetLanguage: 'zh-CN' as const });

  beforeEach(async () => {
    await h.host.settings.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'test-key' } } });
  });

  it('explains via core, caches in SQLite and serves instant cache hits', async () => {
    expect(await h.host.ai.getCachedExplanation(request())).toBeUndefined();
    const expl = await h.host.ai.explain(request());
    expect(expl.sentence).toBe(geminiFixture.sentence);
    expect(expl.fromCache).toBe(false);
    expect(expl.chunks.length).toBeGreaterThan(0);
    expect(expl.chunks[0]?.charSpan).toEqual([0, 3]);
    expect(expl.ruby.map((r) => r.base).join('')).toBe(geminiFixture.sentence);
    expect(h.geminiCalls()).toBe(1);

    const started = performance.now();
    const hit = await h.ctx.host.ai.getCachedExplanation(request());
    expect(performance.now() - started).toBeLessThan(5);
    expect(hit?.fromCache).toBe(true);
    const again = await h.host.ai.explain(request());
    expect(again.fromCache).toBe(true);
    expect(h.geminiCalls()).toBe(1);
    expect(h.ctx.repos.explanations.count()).toBe(1);

    const answer = await h.host.ai.followUp({ explanationId: expl.id, explanation: expl, history: [], question: 'なぜ？', targetLanguage: 'zh-CN' });
    expect(answer.role).toBe('model');
    const deltas: FollowUpDelta[] = [];
    const streamed = await h.host.ai.followUpStream?.({ explanationId: expl.id, history: [], question: 'もう一度', targetLanguage: 'zh-CN' }, (d) => deltas.push(d));
    expect(deltas.filter((d) => !d.done).map((d) => d.textDelta).join('')).toBe('こんにちは');
    expect(streamed?.text).toBe('こんにちは');
    const thread = await h.host.ai.getThread(expl.id);
    expect(thread.map((m) => m.role)).toEqual(['user', 'model', 'user', 'model']);

    expect(await h.host.ai.clearCache()).toEqual({ removed: 1 });
    expect(await h.host.ai.getCachedExplanation(request())).toBeUndefined();
    expect(await h.host.ai.getThread(expl.id)).toEqual([]);
  });

  it('surfaces provider errors with KotoriError codes', async () => {
    await h.host.settings.update({ ai: { provider: { provider: 'vertex-ai', location: 'us-central1', project: 'p', auth: { kind: 'access-token', accessToken: '' } } } });
    await expect(h.host.ai.explain(request())).rejects.toMatchObject({ code: 'ai-auth' });
    await expect(h.host.ai.followUp({ explanationId: 'ex_missing', history: [], question: '?', targetLanguage: 'zh-CN' })).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('downloads & discovery', () => {
  it('searches Nyaa and browses the mokuro.moe catalog through core parsers', async () => {
    const items = await h.host.downloads.searchNyaa({ query: 'show' });
    expect(items[0]).toMatchObject({ seeders: 12, trusted: true, infoHash: '0123456789abcdef0123456789abcdef01234567' });
    expect(h.fetchLog.some((u) => u.startsWith('https://nyaa.si/?'))).toBe(true);
    const listing = await h.host.downloads.browseMokuroCatalog();
    expect(listing.volumes[0]).toMatchObject({ name: 'Vol1', imagesKind: 'archive' });
    await expect(h.host.downloads.searchNyaa({ query: '  ' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('runs an http download to completion with events, then removes it with its file', async () => {
    const task = await h.host.downloads.start({ source: { kind: 'http', url: 'https://example.com/file.bin', fileName: 'file.bin' }, autoImport: false });
    expect(task.kind).toBe('http-file');
    await vi.waitFor(async () => expect((await h.host.downloads.get(task.id)).status).toBe('completed'));
    const done = await h.host.downloads.get(task.id);
    expect(done).toMatchObject({ progress: 1, downloadedBytes: 4096 });
    const updates = h.events.filter((e): e is Extract<HostEvent, { type: 'download-updated' }> => e.type === 'download-updated' && e.task.id === task.id);
    expect(updates.map((u) => u.task.status)).toEqual(expect.arrayContaining(['queued', 'downloading', 'completed']));
    expect(await h.host.downloads.list()).toHaveLength(1);
    const file = join(done.targetDir, 'file.bin');
    expect(readFileSync(file).length).toBe(4096);
    await h.host.downloads.remove(task.id, true);
    expect(h.events).toContainEqual({ type: 'download-removed', taskId: task.id });
    expect(() => readFileSync(file)).toThrow();
    await expect(h.host.downloads.get(task.id)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('files', () => {
  it('lists directories (dirs first, hidden skipped) and opens external URLs', async () => {
    await mkdir(join(h.dir, 'b-dir'));
    await writeFile(join(h.dir, 'a-file.txt'), 'x');
    await writeFile(join(h.dir, '.hidden'), 'x');
    const listing = await h.host.files.listDirectory?.();
    expect(listing?.path).toBe(h.dir);
    const names = listing?.entries.map((e) => e.name) ?? [];
    expect(names.indexOf('b-dir')).toBeLessThan(names.indexOf('a-file.txt'));
    expect(names).not.toContain('.hidden');
    expect(listing?.parent).toBeDefined();
    await h.host.files.openExternal?.('magnet:?xt=urn:btih:abc');
    expect(h.opener).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc');
    await expect(h.host.files.openExternal?.('javascript:alert(1)')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(h.host.files.openExternal?.('file:///tmp/evil.command')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(h.host.files.openExternal?.('/tmp/evil.app')).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(h.opener).toHaveBeenCalledTimes(1);
    await expect(h.host.files.listDirectory?.('relative')).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('server-sent events', () => {
  it('delivers HostEvents to RestPlatformHost subscribers', async () => {
    const received: HostEvent[] = [];
    const unsubscribe = h.host.subscribe((e) => received.push(e));
    // Wait until the SSE handler has subscribed to the hub (harness listener + SSE listener).
    await vi.waitFor(() => expect(h.ctx.events.size).toBe(2));
    await h.host.settings.update({ ui: { fontScale: 1.2 } });
    await vi.waitFor(() => expect(received.some((e) => e.type === 'settings-changed')).toBe(true));
    unsubscribe();
    await vi.waitFor(() => expect(h.ctx.events.size).toBe(1));
  });
});

describe('static UI and TCP server', () => {
  it('serves dist/web with SPA fallback and blocks traversal', async () => {
    const web = join(h.dir, 'web');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(web, 'assets', 'app.js'), 'console.log(1)');
    const w = await harness({ webDir: web });
    try {
      const index = await w.app.request('/');
      expect(index.headers.get('content-type')).toContain('text/html');
      const js = await w.app.request('/assets/app.js');
      expect(js.headers.get('content-type')).toContain('javascript');
      expect(js.headers.get('cache-control')).toContain('immutable');
      const spa = await w.app.request('/anime/series/123');
      expect(await spa.text()).toContain('id="root"');
      const traversal = await w.app.request('/..%2F..%2Fetc%2Fpasswd');
      expect(await traversal.text()).toContain('id="root"');
      expect((await w.app.request('/api/nope')).status).toBe(404);
    } finally {
      await w.ctx.close();
      await rm(w.dir, { recursive: true, force: true });
    }
  });

  it('listens on 127.0.0.1 and shuts down cleanly', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'kotori-tcp-'));
    const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, openBrowser: false }, { ffmpeg: null });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${server.url}/api/info`);
      expect(((await res.json()) as { data: { platform: string } }).data.platform).toBe('node');
      const host = createRestPlatformHost({ baseUrl: server.url });
      expect(await host.anime.listSeries()).toEqual([]);
      const events: HostEvent[] = [];
      const unsubscribe = host.subscribe((e) => events.push(e));
      await vi.waitFor(() => expect(server.ctx.events.size).toBe(1));
      await host.settings.update({ ui: { theme: 'light' } });
      await vi.waitFor(() => expect(events.some((e) => e.type === 'settings-changed')).toBe(true));
      unsubscribe();
      await host.dispose();
    } finally {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
