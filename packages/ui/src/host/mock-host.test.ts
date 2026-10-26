import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent, PlatformHost } from '@kotori/core';
import { createMockPlatformHost } from './mock-host';

describe('createMockPlatformHost', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves 2 series × 3 episodes with ASS tracks', async () => {
    const host: PlatformHost = createMockPlatformHost({ latencyMs: 0 });
    const series = await host.anime.listSeries();
    expect(series).toHaveLength(2);
    for (const s of series) {
      const eps = await host.anime.listEpisodes(s.id);
      expect(eps).toHaveLength(3);
      const track = eps[0]?.subtitleTracks.find((tr) => tr.format === 'ass' && tr.origin !== 'embedded');
      const parsed = await host.anime.getCues(track?.id ?? '');
      expect(parsed.cues.some((c) => c.markup?.posFraction)).toBe(true);
      parsed.cues.forEach((c, i) => expect(c.index).toBe(i));
    }
  });

  it('serves a .mokuro volume with vertical blocks and a raw volume', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const vols = await host.manga.listVolumes();
    const mokuro = vols.find((v) => v.kind === 'mokuro');
    const raw = vols.find((v) => v.kind === 'images');
    expect(mokuro?.pageCount).toBe(10);
    const pages = await host.manga.getPages(mokuro?.id ?? '');
    const block = pages[1]?.blocks[0];
    expect(block?.vertical).toBe(true);
    expect(block?.text).toBe(block?.lines.join(''));
    expect(pages.some((p) => p.width > p.height)).toBe(true);
    expect((await host.manga.getPages(raw?.id ?? ''))[1]?.blocks).toHaveLength(0);
  });

  it('explains with aligned chunks and caches by sentence', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const req = { sentence: '行かなきゃ', source: { kind: 'manual' as const }, targetLanguage: 'zh-CN' as const };
    expect(await host.ai.getCachedExplanation(req)).toBeUndefined();
    const ex = await host.ai.explain(req);
    expect(ex.chunks[0]?.textbookForm).toBe('行かなければならない');
    expect(ex.ruby.map((r) => r.base).join('')).toBe(ex.sentence);
    expect((await host.ai.getCachedExplanation(req))?.fromCache).toBe(true);
  });

  it('rejects an aborted explain with code cancelled', async () => {
    const host = createMockPlatformHost({ latencyMs: 50 });
    const ac = new AbortController();
    const p = host.ai.explain({ sentence: 'x', source: { kind: 'manual' }, targetLanguage: 'zh-CN' }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('simulates download progress with events and auto-imports manga', async () => {
    vi.useFakeTimers();
    const host = createMockPlatformHost({ latencyMs: 0, downloadTickMs: 500 });
    const events: HostEvent[] = [];
    host.subscribe((e) => events.push(e));
    const listing = await host.downloads.browseMokuroCatalog('https://mokuro.moe/manga/%E6%94%BE%E8%AA%B2%E5%BE%8C%E3%83%8E%E3%83%BC%E3%83%88/');
    const volume = listing.volumes[0];
    if (!volume) throw new Error('no volume');
    const task = await host.downloads.start({ source: { kind: 'mokuro-moe', volume }, autoImport: true });
    await vi.advanceTimersByTimeAsync(500 * 30);
    const final = await host.downloads.get(task.id);
    expect(final.status).toBe('completed');
    expect(final.importedVolumeId).toBeDefined();
    expect(events.filter((e) => e.type === 'download-updated').length).toBeGreaterThan(3);
    expect(events.some((e) => e.type === 'library-changed' && e.scope === 'manga')).toBe(true);
    await host.dispose();
  });

  it('mock VLM OCR finds the bubble under a selection on a raw page', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const res = await host.ai.ocrBubble({
      volumeId: 'vol-hoshikuzu-raw-1',
      pageIndex: 3,
      rect: { left: 950, top: 100, right: 1080, bottom: 400 },
      image: { mimeType: 'image/jpeg', base64: '', width: 10, height: 10 },
      explain: true,
      targetLanguage: 'zh-CN',
    });
    expect(res.text).toBe('行かなきゃ');
    expect(res.explanation?.chunks[0]?.spokenEvolution).toBeDefined();
  });
});
