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

  it('sorts Jimaku entries and filters/sorts subtitle files', async () => {
    const host = createMockPlatformHost({ latencyMs: 0, settings: { anime: { jimakuApiKey: 'jk' } } });
    await useSettingsStore.getState().load(host);
    mount(host, <JimakuSearch />);
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByRole('button', { name: /ことりの約束/ });

    fireEvent.click(screen.getByRole('button', { name: '名称 A-Z' }));
    const entryCards = document.querySelectorAll('.k-dl-media-card');
    expect(entryCards[0]).toHaveTextContent('ことりの約束');

    fireEvent.click(entryCards[0] as HTMLElement);
    await screen.findAllByRole('button', { name: '下载' });

    fireEvent.click(screen.getByRole('button', { name: '仅 ASS' }));
    expect(screen.getAllByRole('button', { name: '下载' })).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: '仅 ASS' }));
    expect(screen.getAllByRole('button', { name: '下载' })).toHaveLength(7);
    await host.dispose();
  });
});

describe('MokuroCatalogBrowser', () => {
  it('navigates directories via breadcrumbs, renders rich metadata badges, and starts a volume download', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const start = vi.spyOn(host.downloads, 'start');
    mount(host, <MokuroCatalogBrowser />);
    const houkago = await screen.findByRole('button', { name: /放課後ノート/ });
    expect(houkago).toHaveTextContent('★ 84%');
    expect(houkago).toHaveTextContent('4 卷');
    expect(houkago).toHaveTextContent('720 页');
    expect(houkago).toHaveTextContent('5.8万字');
    expect(houkago).toHaveTextContent('Slice of Life');
    fireEvent.click(houkago);
    const dl = await screen.findAllByRole('button', { name: '下载并导入' });
    expect(dl).toHaveLength(4);
    expect(screen.getByText('180 页')).toBeInTheDocument();
    fireEvent.click(dl[0] as HTMLElement);
    await waitFor(() => expect(start).toHaveBeenCalled());
    const req = start.mock.calls[0]?.[0] as DownloadRequest;
    expect(req.source.kind).toBe('mokuro-moe');
    if (req.source.kind === 'mokuro-moe') expect(req.source.volume.mokuroUrl).toMatch(/\.mokuro$/);
    fireEvent.click(screen.getByRole('button', { name: 'mokuro.moe' }));
    expect(await screen.findByRole('button', { name: /よつばと/ })).toBeInTheDocument();
    await host.dispose();
  });

  it('sorts series by score, latest, volumes and chars, and sorts volumes inside a series', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    mount(host, <MokuroCatalogBrowser />);
    await screen.findByRole('button', { name: /放課後ノート/ });

    fireEvent.click(screen.getByRole('button', { name: '评分最高' }));
    const byScore = document.querySelectorAll('.k-dl-media-card');
    expect(byScore[0]).toHaveTextContent('葬送のフリーレン');

    fireEvent.click(screen.getByRole('button', { name: '最近更新' }));
    const byLatest = document.querySelectorAll('.k-dl-media-card');
    expect(byLatest[0]).toHaveTextContent('ゆるキャン△');

    fireEvent.click(screen.getByRole('button', { name: '卷数最多' }));
    const byVols = document.querySelectorAll('.k-dl-media-card');
    expect(byVols[0]).toHaveTextContent('ハイキュー!!');

    fireEvent.click(screen.getByRole('button', { name: '字数最多' }));
    const byChars = document.querySelectorAll('.k-dl-media-card');
    expect(byChars[0]).toHaveTextContent('ハイキュー!!');

    fireEvent.click(byChars[0] as HTMLElement);
    await screen.findAllByRole('button', { name: '下载并导入' });
    fireEvent.click(screen.getByRole('button', { name: '倒序 (N→1)' }));
    const volCards = document.querySelectorAll('.k-dl-volume-card');
    expect(volCards[0]).toHaveTextContent('第04巻');
    await host.dispose();
  });
});
