import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRouteStore } from '../../app/routes';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost } from '../../host/mock-host';
import { resetStores } from '../../test/utils';
import { SeriesDetail } from '../anime/SeriesDetail';
import { useAnimeStore } from '../anime/useAnimeStore';
import { MangaLibrary } from '../manga/MangaLibrary';
import { AiCacheGlobalBar } from './AiCacheGlobalBar';
import { isActivePhase, setAiCacheDeps, useAiCacheStore } from './useAiCacheStore';

beforeEach(() => {
  resetStores();
  setAiCacheDeps({ loadPageImage: async (p) => ({ mimeType: 'image/jpeg', base64: 'AAAA', width: p.width, height: p.height }) });
});
afterEach(cleanup);

describe('SeriesDetail 「缓存AI解读」', () => {
  async function setup(latencyMs = 0) {
    const host = createMockPlatformHost({ latencyMs });
    await useAnimeStore.getState().loadSeries(host);
    render(
      <HostProvider host={host}>
        <SeriesDetail seriesId="series-kotori" />
      </HostProvider>,
    );
    return host;
  }

  it('caches one episode from its row without opening the player', async () => {
    const host = await setup();
    const btn = await screen.findByTestId('episode-cache-explain-series-kotori-ep1');
    expect(btn).toHaveTextContent('缓存AI解读');
    fireEvent.click(btn);
    expect(useRouteStore.getState().anime.kind).not.toBe('player');
    await waitFor(() => expect(useAiCacheStore.getState().jobs['anime:series-kotori-ep1']?.phase).toBe('done'));
    const job = useAiCacheStore.getState().jobs['anime:series-kotori-ep1']!;
    expect(screen.getByTestId('episode-cache-explain-series-kotori-ep1')).toHaveTextContent(`已缓存 ${job.totalItems}/${job.totalItems}`);
    expect(host.calls.get('ai.getCachedStatus')).toBe(1);
    expect(host.calls.get('ai.explainBatch')).toBe(Math.ceil(job.totalItems / 8));
    expect(useRouteStore.getState().anime.kind).not.toBe('player');
  });

  it('「缓存全季解读」 queues every episode and runs them one at a time', async () => {
    const host = await setup(1);
    await screen.findByTestId('episode-cache-explain-series-kotori-ep1');
    const episodes = await host.anime.listEpisodes('series-kotori');
    expect(episodes.length).toBeGreaterThan(1);
    let maxRunning = 0;
    const unsub = useAiCacheStore.subscribe((s) => {
      const running = Object.values(s.jobs).filter((j) => isActivePhase(j.phase) && j.phase !== 'queued').length;
      maxRunning = Math.max(maxRunning, running);
    });
    fireEvent.click(screen.getByTestId('series-cache-explain-all'));
    expect(Object.values(useAiCacheStore.getState().jobs).filter((j) => j.phase === 'queued').length).toBeGreaterThanOrEqual(episodes.length - 1);
    await waitFor(() => expect(Object.values(useAiCacheStore.getState().jobs).every((j) => j.phase === 'done' || j.phase === 'error')).toBe(true), { timeout: 8000 });
    unsub();
    expect(maxRunning).toBe(1);
    expect(Object.keys(useAiCacheStore.getState().jobs)).toHaveLength(episodes.length);
  });
});

describe('MangaLibrary 「缓存AI解读」', () => {
  it('caches a volume from its card without opening the reader, with inline progress', async () => {
    const host = createMockPlatformHost({ latencyMs: 5 });
    const opened: string[] = [];
    render(
      <HostProvider host={host}>
        <MangaLibrary onOpen={(id) => opened.push(id)} />
      </HostProvider>,
    );
    const btn = await screen.findByTestId('volume-cache-explain-vol-houkago-1');
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(opened).toEqual([]);
    await waitFor(() => expect(screen.getByTestId('volume-cache-explain-vol-houkago-1')).toHaveAttribute('data-phase', 'explaining'));
    expect(screen.getByTestId('volume-cache-explain-vol-houkago-1').querySelector('.k-linear-progress')).not.toBeNull();
    await waitFor(() => expect(useAiCacheStore.getState().jobs['manga:vol-houkago-1']?.phase).toBe('done'), { timeout: 4000 });
    expect(screen.getByTestId('volume-cache-explain-vol-houkago-1')).toHaveTextContent(/已缓存 \d+\/\d+/);
    expect(opened).toEqual([]);
  });
});

describe('AiCacheGlobalBar', () => {
  it('shows background progress on other screens with a working × cancel, and hides on the job’s own screen', async () => {
    const host = createMockPlatformHost({ latencyMs: 20 });
    render(
      <HostProvider host={host}>
        <AiCacheGlobalBar />
      </HostProvider>,
    );
    expect(screen.queryByTestId('ai-cache-global-bar')).toBeNull();
    act(() => useAiCacheStore.getState().start(host, { kind: 'manga', volumeId: 'vol-houkago-1', title: '放課後ノート 1' }));
    const bar = await screen.findByTestId('ai-cache-global-bar');
    expect(bar).toHaveTextContent('放課後ノート 1');
    await waitFor(() => expect(screen.getByTestId('ai-cache-global-progress')).toHaveTextContent(/缓存中 \d+\/\d+/));

    // On the reader for that very volume the reader's own pill is used instead.
    act(() => useRouteStore.getState().openManga({ kind: 'reader', volumeId: 'vol-houkago-1' }));
    expect(screen.queryByTestId('ai-cache-global-bar')).toBeNull();
    act(() => useRouteStore.getState().openManga({ kind: 'library' }));
    fireEvent.click(await screen.findByTestId('ai-cache-global-cancel'));
    await waitFor(() => expect(useAiCacheStore.getState().jobs['manga:vol-houkago-1']?.phase).toBe('cancelled'));
    expect(screen.queryByTestId('ai-cache-global-bar')).toBeNull();
  });
});
