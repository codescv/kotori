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

const search = async (q: string): Promise<HTMLElement[]> => {
  fireEvent.change(screen.getByLabelText('搜索 Nyaa（如：Frieren 1080p）'), { target: { value: q } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  return screen.findAllByTestId('nyaa-result');
};

beforeEach(() => useDownloadsStore.getState().reset());
afterEach(() => cleanup());

describe('NyaaSearch', () => {
  it('renders results with parsed episode, seeders and size', async () => {
    const host = setup();
    const spy = vi.spyOn(host.downloads, 'searchNyaa');
    const rows = await search('Frieren');
    expect(rows).toHaveLength(12);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ query: 'Frieren', filter: 'none' }));
    expect(rows[0]).toHaveTextContent('[SubsPlease] Frieren - 12');
    expect(rows[0]).toHaveTextContent('第 12 集');
    expect(rows[0]).toHaveTextContent('▲ 480');
    expect(rows[11]).toHaveTextContent('合集 1–12');
  });

  it('filter chips re-run the search', async () => {
    const host = setup();
    await search('Frieren');
    const spy = vi.spyOn(host.downloads, 'searchNyaa');
    fireEvent.click(screen.getByRole('button', { name: '仅可信' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ filter: 'trusted-only' })));
    await waitFor(() => expect(screen.getAllByTestId('nyaa-result')).toHaveLength(9));
  });

  it('1-click download starts a torrent task with the nyaa item as source', async () => {
    const host = setup();
    const start = vi.spyOn(host.downloads, 'start');
    const rows = await search('Frieren');
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
    await waitFor(() => expect([...useDownloadsStore.getState().tasks.values()].some((t) => t.title.includes('Frieren - 12'))).toBe(true));
    await host.dispose();
  });

  it('without a torrent engine offers "open magnet externally"', async () => {
    const host = setup({ capabilities: { torrent: false } });
    const open = vi.spyOn(host.files, 'openExternal');
    await search('Frieren');
    expect(screen.queryByRole('button', { name: '下载' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '用外部应用打开磁力链接' })[0] as HTMLElement);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^magnet:\?xt=urn:btih:/));
  });
});
