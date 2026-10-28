import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DownloadRequest } from '@kotori/core';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../host/mock-host';
import { NyaaSearch } from './NyaaSearch';
import { useDownloadsStore } from './useDownloadsStore';

function setup(opts: Parameters<typeof createMockPlatformHost>[0] = {}): MockPlatformHost {
  const host = createMockPlatformHost({ latencyMs: 0, ...opts });
  render(
    <HostProvider host={host}>
      <NyaaSearch />
    </HostProvider>,
  );
  return host;
}

const searchDirect = async (q: string): Promise<HTMLElement[]> => {
  fireEvent.click(screen.getByRole('button', { name: '直接搜种子' }));
  fireEvent.change(screen.getByLabelText('搜索 Nyaa（如：Frieren 1080p）'), { target: { value: q } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  return screen.findAllByTestId('nyaa-result');
};

beforeEach(() => useDownloadsStore.getState().reset());
afterEach(() => cleanup());

describe('NyaaSearch', () => {
  it('Stage 1 -> Stage 2: searches Bocchi series list, opens Series Detail, and ranks [Judas] Bocchi the Rock! #1', async () => {
    const host = setup({ settings: { anime: { jimakuApiKey: 'jk' } } });
    const spy = vi.spyOn(host.downloads, 'searchNyaa');

    // Stage 1: Search for 'bocchi' -> narrows from 12 trending cards to 2 matching Bocchi series cards
    expect(screen.getAllByTestId('anime-series-card')).toHaveLength(12);
    fireEvent.change(screen.getByLabelText('搜索 Nyaa（如：Frieren 1080p）'), { target: { value: 'bocchi' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    await screen.findByText('匹配 2 部番剧');
    const seriesCards = screen.getAllByTestId('anime-series-card');
    expect(seriesCards).toHaveLength(2);
    expect(seriesCards[0]).toHaveTextContent('ぼっち・ざ・ろっく！');
    expect(seriesCards[0]).toHaveTextContent('Bocchi the Rock!');
    expect(seriesCards[0]).toHaveTextContent('★ 87%');

    // Stage 2: Click the Bocchi series card -> opens Series Detail and searches Nyaa across aliases with category 1_0
    fireEvent.click(seriesCards[0] as HTMLElement);
    const detailBanner = await screen.findByTestId('series-detail-banner');
    expect(detailBanner).toHaveTextContent('CloverWorks');
    expect(detailBanner).toHaveTextContent('孤独摇滚！');

    const rows = await screen.findAllByTestId('nyaa-result');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ query: 'Bocchi the Rock!', category: '1_0' }));
    expect(rows[0]).toHaveTextContent('[Judas] Bocchi the Rock! (Season 1) [BD 1080p][HEVC x265 10bit][Multi-Subs] (Batch)');

    // Filter by Batch only
    fireEvent.click(screen.getByRole('button', { name: '仅合集 Batch' }));
    const batchRows = screen.getAllByTestId('nyaa-result');
    expect(batchRows.length).toBe(5);
    expect(batchRows[0]).toHaveTextContent('[Judas] Bocchi the Rock!');

    // Compact viewport: category / trust / sort rows are collapsed behind one toggle chip.
    expect(screen.queryByRole('button', { name: '仅可信' })).toBeNull();
    expect(screen.queryByRole('button', { name: '多语/英译' })).toBeNull();
    const filtersToggle = screen.getByTestId('nyaa-filters-toggle');
    expect(filtersToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(filtersToggle);
    expect(filtersToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '仅可信' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '多语/英译' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '按体积' }));
    expect(screen.getByTestId('nyaa-filters-toggle')).toHaveTextContent('筛选与排序 (1)');

    // Switch to integrated Jimaku Subtitles tab inside Series Detail
    fireEvent.click(screen.getByRole('button', { name: /日语字幕 Jimaku/ }));
    const subFiles = await screen.findAllByTestId('series-jimaku-file');
    expect(subFiles.length).toBeGreaterThan(0);

    // Return to Series List
    fireEvent.click(screen.getByTestId('back-to-series-list'));
    expect(await screen.findAllByTestId('anime-series-card')).toHaveLength(seriesCards.length);
  });

  it('renders direct torrent results with parsed episode, seeders and size', async () => {
    const host = setup();
    const spy = vi.spyOn(host.downloads, 'searchNyaa');
    const rows = await searchDirect('Frieren');
    expect(rows).toHaveLength(12);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ query: 'Frieren', category: '1_0', filter: 'none' }));
    expect(rows[0]).toHaveTextContent('[SubsPlease] Frieren - 12');
    expect(rows[0]).toHaveTextContent('第 12 集');
    expect(rows[0]).toHaveTextContent('▲ 480');
    expect(rows[11]).toHaveTextContent('合集 1–12');
  });

  it('filter chips re-run the search', async () => {
    const host = setup();
    await searchDirect('Frieren');
    const spy = vi.spyOn(host.downloads, 'searchNyaa');
    fireEvent.click(screen.getByRole('button', { name: '仅可信' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ filter: 'trusted-only' })));
    await waitFor(() => expect(screen.getAllByTestId('nyaa-result')).toHaveLength(9));
  });

  it('sort chips reorder results client-side by seeders, date, size and downloads', async () => {
    setup();
    await searchDirect('Frieren');
    fireEvent.click(screen.getByRole('button', { name: '按体积' }));
    expect(screen.getAllByTestId('nyaa-result')[0]).toHaveTextContent('14.2 GiB');

    fireEvent.click(screen.getByRole('button', { name: '按完成量' }));
    expect(screen.getAllByTestId('nyaa-result')[0]).toHaveTextContent('✓ 9400');

    fireEvent.click(screen.getByRole('button', { name: '按时间' }));
    expect(screen.getAllByTestId('nyaa-result')[0]).toHaveTextContent('[Kotori-Raws] Frieren - 11');

    fireEvent.click(screen.getByRole('button', { name: '按做种' }));
    expect(screen.getAllByTestId('nyaa-result')[0]).toHaveTextContent('▲ 480');
  });

  it('1-click download starts a torrent task with the nyaa item as source', async () => {
    const host = setup();
    const start = vi.spyOn(host.downloads, 'start');
    const rows = await searchDirect('Frieren');
    const first = rows[0];
    if (!first) throw new Error('no rows');
    fireEvent.click(first.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const req = start.mock.calls[0]?.[0] as DownloadRequest;
    expect(req.autoImport).toBe(true);
    expect(req.source.kind).toBe('torrent');
    if (req.source.kind !== 'torrent') throw new Error('unreachable');
    expect(req.source.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(req.source.magnet).toMatch(/^magnet:\?xt=urn:btih:/);
    expect(req.source.torrentUrl).toMatch(/\.torrent$/);
    expect(req.source.nyaa?.title).toContain('Frieren - 12');
    await waitFor(() =>
      expect([...useDownloadsStore.getState().tasks.values()].some((t) => t.title.includes('Frieren - 12'))).toBe(true),
    );
    await host.dispose();
  });

  it('without a torrent engine offers "open magnet externally"', async () => {
    const host = setup({ capabilities: { torrent: false } });
    const open = vi.spyOn(host.files, 'openExternal');
    await searchDirect('Frieren');
    expect(screen.queryByRole('button', { name: '下载' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '用外部应用打开磁力链接' })[0] as HTMLElement);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^magnet:\?xt=urn:btih:/));
  });
});
