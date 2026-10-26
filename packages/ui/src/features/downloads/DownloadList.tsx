/**
 * Live download task list: status chip, progress, speed / ETA / peers and
 * pause · resume · cancel · remove actions. Rows update from host events via
 * `useDownloadsStore` (the page wires the subscription).
 */
import type { DownloadStatus, DownloadTask } from '@kotori/core';
import { useState } from 'react';
import { useHost } from '../../host/HostContext';
import { useT, type MessageKey } from '../../i18n';
import { Icon, type IconName } from '../../components/m3/Icon';
import { IconButton } from '../../components/m3/IconButton';
import { LinearProgress } from '../../components/m3/Progress';
import { cx } from '../../components/m3/cx';
import { showSnackbar } from '../../stores/snackbar';
import { useRouteStore } from '../../app/routes';
import { formatBytes, formatEta, formatSpeed } from './format';
import { sortTasks, useDownloadsStore } from './useDownloadsStore';

const KIND_ICON: Record<DownloadTask['kind'], IconName> = {
  torrent: 'magnet',
  'jimaku-subtitle': 'subtitles',
  'mokuro-volume': 'book',
  'http-file': 'link',
};

const ACTIVE: ReadonlySet<DownloadStatus> = new Set(['queued', 'resolving', 'downloading', 'importing']);

export function statusKey(status: DownloadStatus): MessageKey {
  return `downloads.status.${status}`;
}

function TaskRow({ task }: { readonly task: DownloadTask }) {
  const host = useHost();
  const t = useT();
  const upsert = useDownloadsStore((s) => s.upsert);
  const receive = useDownloadsStore((s) => s.receive);
  const [busy, setBusy] = useState(false);
  const openAnime = useRouteStore((s) => s.openAnime);
  const openManga = useRouteStore((s) => s.openManga);

  const act = async (fn: () => Promise<DownloadTask | void>): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      if (r) upsert(r);
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const active = ACTIVE.has(task.status);
  const showProgress = task.status !== 'completed' && task.status !== 'cancelled';
  const pct = Math.round(task.progress * 100);
  return (
    <li className={cx('k-dl-task', `is-${task.status}`)} data-testid={`task-${task.id}`} data-status={task.status}>
      <span className="k-dl-task__icon">
        <Icon name={KIND_ICON[task.kind]} />
      </span>
      <div className="k-dl-task__main">
        <div className="k-dl-task__title" title={task.title}>
          {task.title}
        </div>
        <div className="k-dl-task__meta">
          <span className={cx('k-dl-status', `k-dl-status--${task.status}`)} data-testid="task-status">
            {t(statusKey(task.status))}
          </span>
          <span data-testid="task-percent">{pct}%</span>
          <span>
            {formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}
          </span>
          {task.status === 'downloading' && <span>{formatSpeed(task.speedBps)}</span>}
          {task.status === 'downloading' && task.etaMs !== undefined && <span>{t('downloads.eta', { eta: formatEta(task.etaMs) })}</span>}
          {task.peers !== undefined && active && <span>{t('downloads.peers', { peers: task.peers })}</span>}
          {task.error && <span className="k-error-text">{task.error}</span>}
        </div>
        {showProgress && <LinearProgress {...(task.status === 'resolving' || task.status === 'queued' ? {} : { value: task.progress })} label={task.title} />}
      </div>
      <div className="k-dl-task__actions">
        {task.status === 'completed' && task.importedSeriesId && (
          <IconButton icon="openExternal" label={t('common.open')} onClick={() => openAnime({ kind: 'series', seriesId: task.importedSeriesId ?? '' })} />
        )}
        {task.status === 'completed' && task.importedVolumeId && (
          <IconButton icon="openExternal" label={t('common.open')} onClick={() => openManga({ kind: 'reader', volumeId: task.importedVolumeId ?? '' })} />
        )}
        {(task.status === 'downloading' || task.status === 'resolving' || task.status === 'queued') && (
          <IconButton icon="pause" label={t('downloads.pause')} disabled={busy} onClick={() => void act(() => host.downloads.pause(task.id))} />
        )}
        {(task.status === 'paused' || task.status === 'failed') && (
          <IconButton icon="play" label={t('downloads.resume')} disabled={busy} onClick={() => void act(() => host.downloads.resume(task.id))} />
        )}
        {(active || task.status === 'paused') && (
          <IconButton icon="close" label={t('downloads.cancel')} disabled={busy} onClick={() => void act(() => host.downloads.cancel(task.id))} />
        )}
        {!active && (
          <IconButton icon="delete" label={t('downloads.remove')} disabled={busy} onClick={() =>
              void act(async () => {
                await host.downloads.remove(task.id);
                receive({ type: 'download-removed', taskId: task.id });
              })
            } />
        )}
      </div>
    </li>
  );
}

export function DownloadList() {
  const t = useT();
  const tasks = useDownloadsStore((s) => s.tasks);
  const loaded = useDownloadsStore((s) => s.loaded);
  const error = useDownloadsStore((s) => s.error);
  const list = sortTasks(tasks);
  if (error) return <p className="k-empty k-error-text">{t('common.error', { message: error })}</p>;
  if (!loaded && list.length === 0) return <LinearProgress label={t('common.loading')} />;
  if (list.length === 0) return <p className="k-empty">{t('downloads.tasks.empty')}</p>;
  return (
    <ul className="k-dl-list" aria-label={t('downloads.tab.tasks')}>
      {list.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </ul>
  );
}
