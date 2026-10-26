import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DownloadTask } from '@kotori/core';
import { useRouteStore } from '../../app/routes';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../host/mock-host';
import { useSettingsStore } from '../../stores/settings';
import { DownloadsPage } from './DownloadsPage';
import { useDownloadsStore } from './useDownloadsStore';

const task = (over: Partial<DownloadTask> = {}): DownloadTask => ({
  id: 'task-live',
  kind: 'torrent',
  source: { kind: 'torrent', infoHash: 'a'.repeat(40) },
  title: '[Kotori-Raws] Live Test - 01 (1080p).mkv',
  status: 'downloading',
  progress: 0.25,
  downloadedBytes: 250 * 1024 * 1024,
  totalBytes: 1000 * 1024 * 1024,
  speedBps: 5 * 1024 * 1024,
  etaMs: 150_000,
  peers: 12,
  targetDir: '/downloads',
  createdAt: Date.UTC(2026, 9, 26),
  updatedAt: Date.UTC(2026, 9, 26),
  ...over,
});

async function setup(): Promise<MockPlatformHost> {
  const host = createMockPlatformHost({ latencyMs: 0 });
  render(
    <HostProvider host={host}>
      <DownloadsPage />
    </HostProvider>,
  );
  // Seeded tasks from the mock host appear after list().
  await screen.findByTestId('task-task-seed-1');
  return host;
}

beforeEach(() => {
  useDownloadsStore.getState().reset();
  useRouteStore.getState().reset();
  useSettingsStore.getState().reset();
});
afterEach(() => cleanup());

describe('DownloadList (live HostEvents)', () => {
  it('renders seeded tasks with their status', async () => {
    await setup();
    expect(within(screen.getByTestId('task-task-seed-1')).getByTestId('task-status')).toHaveTextContent('已完成');
    expect(within(screen.getByTestId('task-task-seed-2')).getByTestId('task-status')).toHaveTextContent('已暂停');
    expect(screen.getByText('HTTP 404 Not Found')).toBeInTheDocument();
  });

  it('download-updated events add and update rows (progress, status, speed)', async () => {
    const host = await setup();
    act(() => host.emit({ type: 'download-updated', task: task() }));
    const row = await screen.findByTestId('task-task-live');
    expect(within(row).getByTestId('task-status')).toHaveTextContent('下载中');
    expect(within(row).getByTestId('task-percent')).toHaveTextContent('25%');
    expect(row).toHaveTextContent('5.0 MiB/s');
    expect(row).toHaveTextContent('剩余 2m 30s');
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');

    act(() => host.emit({ type: 'download-updated', task: task({ progress: 0.8, downloadedBytes: 800 * 1024 * 1024, updatedAt: Date.UTC(2026, 9, 26, 0, 1) }) }));
    expect(within(screen.getByTestId('task-task-live')).getByTestId('task-percent')).toHaveTextContent('80%');

    act(() => host.emit({ type: 'download-updated', task: task({ status: 'completed', progress: 1, speedBps: 0, updatedAt: Date.UTC(2026, 9, 26, 0, 2) }) }));
    const done = screen.getByTestId('task-task-live');
    expect(within(done).getByTestId('task-status')).toHaveTextContent('已完成');
    expect(within(done).queryByRole('progressbar')).not.toBeInTheDocument();
    // Task-tab badge counts active tasks only.
    expect(screen.getByRole('tab', { name: /任务/ })).not.toHaveTextContent(/\d/);
  });

  it('download-removed events drop the row', async () => {
    const host = await setup();
    act(() => host.emit({ type: 'download-updated', task: task() }));
    await screen.findByTestId('task-task-live');
    act(() => host.emit({ type: 'download-removed', taskId: 'task-live' }));
    expect(screen.queryByTestId('task-task-live')).not.toBeInTheDocument();
  });

  it('pause / resume / remove actions call the host and update the row', async () => {
    const host = await setup();
    const paused = within(screen.getByTestId('task-task-seed-2'));
    fireEvent.click(paused.getByRole('button', { name: '继续' }));
    await waitFor(() => expect(within(screen.getByTestId('task-task-seed-2')).getByTestId('task-status')).toHaveTextContent('下载中'));
    fireEvent.click(within(screen.getByTestId('task-task-seed-2')).getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(within(screen.getByTestId('task-task-seed-2')).getByTestId('task-status')).toHaveTextContent('已暂停'));

    fireEvent.click(within(screen.getByTestId('task-task-seed-3')).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(screen.queryByTestId('task-task-seed-3')).not.toBeInTheDocument());
    expect((await host.downloads.list()).some((t) => t.id === 'task-seed-3')).toBe(false);
    await host.dispose();
  });
});
