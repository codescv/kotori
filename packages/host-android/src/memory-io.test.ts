import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import type { DownloadStatus, DownloadTask, PlatformHost } from '@kotori/core';
import { bytesToStream, extractZip, unzipStream } from './storage/unzip-stream';
import { createTestHost, pngHeader, type TestHost } from './testing/harness';

const open: TestHost[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.host.dispose()));
});

function waitFor(h: PlatformHost, taskId: string, status: DownloadStatus, timeoutMs = 3000): Promise<DownloadTask> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${status}`)), timeoutMs);
    const off = h.subscribe((e) => {
      if (e.type === 'download-updated' && e.task.id === taskId && e.task.status === status) {
        clearTimeout(timer);
        off();
        resolve(e.task);
      }
    });
  });
}

describe('unzipStream', () => {
  const archive = zipSync({
    'vol/p10.png': pngHeader(10, 20),
    'vol/p2.png': [pngHeader(30, 40), { level: 0 }], // STORED entry
    '__MACOSX/vol/._p2.png': new Uint8Array(8),
    'vol/readme.txt': new TextEncoder().encode('hello'.repeat(1000)),
  });

  it('extracts matching entries chunk-by-chunk (deflate + stored) in archive order', async () => {
    const got: Array<[string, number]> = [];
    const count = await unzipStream(bytesToStream(archive, 7), (n) => n.endsWith('.png') && !n.startsWith('__MACOSX/'), async (name, data) => {
      await new Promise((r) => setTimeout(r, 1)); // slow writer → exercises back-pressure
      got.push([name, data.length]);
    });
    expect(count).toBe(2);
    expect(got).toEqual([
      ['vol/p10.png', 33],
      ['vol/p2.png', 33],
    ]);
  });

  it('propagates writer failures', async () => {
    await expect(
      unzipStream(bytesToStream(archive), () => true, async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
  });

  it('extractZip falls back to in-memory extraction without duplicating entries', async () => {
    let calls = 0;
    const broken = (): Promise<ReadableStream<Uint8Array>> => {
      calls += 1;
      let sent = false;
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) controller.error(new Error('stream broke'));
            else {
              sent = true;
              controller.enqueue(archive);
            }
          },
        }),
      );
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const names: string[] = [];
    const n = await extractZip(broken, async () => archive, (name) => name.endsWith('.png') && !name.startsWith('__MACOSX/'), async (name) => {
      names.push(name);
    });
    warn.mockRestore();
    expect(calls).toBe(1);
    expect(n).toBe(2);
    expect(names.sort()).toEqual(['vol/p10.png', 'vol/p2.png']);
  });
});

describe('Android memory-safe I/O wiring', () => {
  it('uses the native downloadToFile path (no fetch body buffering) and reports progress', async () => {
    const fetch = vi.fn(async () => new Response('should not be used'));
    const downloadToFile = vi.fn(async (_url: string, path: string, options: { onProgress: (r: number, t: number | undefined) => void }) => {
      options.onProgress(50, 100);
      options.onProgress(100, 100);
      await t.fs.writeFile(path, new Uint8Array(100).fill(1));
    });
    const t = await createTestHost({ fetch, downloadToFile });
    open.push(t);
    const task = await t.host.downloads.start({ source: { kind: 'http', url: 'https://example.com/big.bin' }, autoImport: false });
    const done = await waitFor(t.host, task.id, 'completed');
    expect(downloadToFile).toHaveBeenCalledTimes(1);
    expect(downloadToFile.mock.calls[0]?.[0]).toBe('https://example.com/big.bin');
    expect(fetch).not.toHaveBeenCalled();
    expect(done.downloadedBytes).toBe(100);
  });

  it('imports a .cbz through the streaming reader (readFileStream), not a whole-file read', async () => {
    const readFileStream = vi.fn(async (path: string) => bytesToStream(await t.fs.readFile(path), 16));
    const t = await createTestHost({ readFileStream });
    open.push(t);
    const cbz = 'file:///sdcard/Download/Series v03.cbz';
    await t.fs.writeFile(cbz, zipSync({ 'p10.png': pngHeader(10, 20), 'p2.png': pngHeader(30, 40), '__MACOSX/._p2.png': new Uint8Array(4) }));
    const volume = await t.host.manga.importVolume({ path: cbz });
    expect(readFileStream).toHaveBeenCalledWith(cbz);
    expect(volume).toMatchObject({ kind: 'images', pageCount: 2, volumeNumber: 3 });
    const pages = await t.host.manga.getPages(volume.id);
    expect(pages.map((p) => p.relativePath)).toEqual(['p2.png', 'p10.png']);
    expect(pages[0]).toMatchObject({ width: 30, height: 40 });
  });

  it('sends Gemini traffic through webFetch (un-patched, streaming-capable) instead of the CapacitorHttp fetch', async () => {
    const fetch = vi.fn(async () => new Response('blocked', { status: 500 }));
    const webFetch = vi.fn(async () =>
      Response.json({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], modelVersion: 'gemini-2.5-flash' }),
    );
    const t = await createTestHost({ fetch, webFetch });
    open.push(t);
    await t.host.settings.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'k' } } });
    const result = await t.host.settings.testAi();
    expect(result.ok).toBe(true);
    expect(webFetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
