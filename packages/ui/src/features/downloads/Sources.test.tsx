import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DownloadRequest } from '@kotori/core';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../host/mock-host';
import { useSettingsStore } from '../../stores/settings';
import { JimakuSearch } from './JimakuSearch';
import { MokuroCatalogBrowser } from './MokuroCatalogBrowser';
import { useDownloadsStore } from './useDownloadsStore';

const mount = (host: MockPlatformHost, node: React.ReactNode): void => {
  render(<HostProvider host={host}>{node}</HostProvider>);
};

beforeEach(() => {
  useSettingsStore.getState().reset();
  useDownloadsStore.getState().reset();
});
afterEach(() => cleanup());

describe('JimakuSearch', () => {
  it('without an API key shows the settings call-to-action', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    await useSettingsStore.getState().load(host);
    mount(host, <JimakuSearch />);
    expect(screen.getByText('需要在设置中填写 Jimaku API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前往设置' })).toBeInTheDocument();
  });

  it('entries → files → download with the jimaku source', async () => {
    const host = createMockPlatformHost({ latencyMs: 0, settings: { anime: { jimakuApiKey: 'jk' } } });
    await useSettingsStore.getState().load(host);
    const start = vi.spyOn(host.downloads, 'start');
    mount(host, <JimakuSearch />);
    fireEvent.change(screen.getByLabelText('搜索 Jimaku 条目（日文/英文名）'), { target: { value: 'kotori' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: /ことりの約束/ }));
    const files = await screen.findAllByRole('button', { name: '下载' });
    expect(files.length).toBeGreaterThan(3);
    fireEvent.click(files[0] as HTMLElement);
    await waitFor(() => expect(start).toHaveBeenCalled());
    const req = start.mock.calls[0]?.[0] as DownloadRequest;
    expect(req.source.kind).toBe('jimaku');
    if (req.source.kind === 'jimaku') expect(req.source.entry.id).toBe(4242);
    await host.dispose();
  });
});

describe('MokuroCatalogBrowser', () => {
  it('navigates directories via breadcrumbs and starts a volume download', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const start = vi.spyOn(host.downloads, 'start');
    mount(host, <MokuroCatalogBrowser />);
    fireEvent.click(await screen.findByRole('button', { name: /放課後ノート/ }));
    const dl = await screen.findAllByRole('button', { name: '下载并导入' });
    expect(dl).toHaveLength(4);
    fireEvent.click(dl[0] as HTMLElement);
    await waitFor(() => expect(start).toHaveBeenCalled());
    const req = start.mock.calls[0]?.[0] as DownloadRequest;
    expect(req.source.kind).toBe('mokuro-moe');
    if (req.source.kind === 'mokuro-moe') expect(req.source.volume.mokuroUrl).toMatch(/\.mokuro$/);
    fireEvent.click(screen.getByRole('button', { name: 'mokuro.moe' }));
    expect(await screen.findByRole('button', { name: /よつばと/ })).toBeInTheDocument();
    await host.dispose();
  });
});
