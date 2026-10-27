/**
 * Top notification banner when a newer Kotori version is available or
 * downloading, plus the Settings "About & Update" action block.
 */
import { Button } from '../../components/m3/Button';
import { IconButton } from '../../components/m3/IconButton';
import { LinearProgress } from '../../components/m3/Progress';
import { useHost } from '../../host/HostContext';
import { formatBytes } from '../downloads/format';
import { useUpdateStore } from './updater';
import './updater.css';

function summariseReleaseNotes(notes: string): string {
  const lines = notes
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '• ').trim())
    .filter((l) => l.length > 0 && !l.startsWith('```'));
  return lines.slice(0, 3).join('  ');
}

export function UpdateBanner() {
  const host = useHost();
  const status = useUpdateStore((s) => s.status);
  const release = useUpdateStore((s) => s.release);
  const progressPercent = useUpdateStore((s) => s.progressPercent);
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes);
  const totalBytes = useUpdateStore((s) => s.totalBytes);
  const needsPermission = useUpdateStore((s) => s.needsPermission);
  const dismissedTag = useUpdateStore((s) => s.dismissedTag);
  const downloadUpdate = useUpdateStore((s) => s.downloadUpdate);
  const installDownloadedApk = useUpdateStore((s) => s.installDownloadedApk);
  const dismiss = useUpdateStore((s) => s.dismiss);

  if (!release) return null;
  if (status === 'available' && dismissedTag === release.tagName) return null;
  if (status !== 'available' && status !== 'downloading' && status !== 'ready-to-install') {
    return null;
  }

  const summary = summariseReleaseNotes(release.notes);

  return (
    <div className="k-update-banner" role="region" aria-label="版本更新提示" data-testid="update-banner">
      <div className="k-update-banner__main">
        <div className="k-update-banner__title-row">
          <span className="k-update-banner__badge">NEW</span>
          <strong className="k-title-small">
            发现新版本 v{release.version}
          </strong>
          {release.apkSizeBytes ? (
            <span className="k-label-small k-muted">({formatBytes(release.apkSizeBytes)})</span>
          ) : null}
        </div>
        {summary && <p className="k-body-small k-update-banner__notes">{summary}</p>}
        {status === 'downloading' && (
          <div className="k-update-banner__progress" data-testid="update-download-progress">
            <LinearProgress {...(progressPercent > 0 ? { value: progressPercent / 100 } : {})} />
            <span className="k-label-small k-muted">
              正在下载更新包… {progressPercent > 0 ? `${progressPercent}%` : ''}{' '}
              {downloadedBytes > 0
                ? `(${formatBytes(downloadedBytes)}${totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ''})`
                : ''}
            </span>
          </div>
        )}
      </div>
      <div className="k-update-banner__actions">
        {status === 'available' && (
          <Button
            variant="filled"
            icon="download"
            onClick={() => void downloadUpdate(host)}
            data-testid="update-banner-download"
          >
            立即更新
          </Button>
        )}
        {status === 'ready-to-install' && (
          <Button
            variant="filled"
            icon="check"
            onClick={() => void installDownloadedApk(host)}
            data-testid="update-banner-install"
          >
            {needsPermission ? '授权后安装' : '安装更新'}
          </Button>
        )}
        {status !== 'downloading' && (
          <IconButton
            icon="close"
            label="稍后提醒"
            onClick={() => dismiss(release.tagName)}
            data-testid="update-banner-dismiss"
          />
        )}
      </div>
    </div>
  );
}

export function UpdateSection() {
  const host = useHost();
  const status = useUpdateStore((s) => s.status);
  const release = useUpdateStore((s) => s.release);
  const progressPercent = useUpdateStore((s) => s.progressPercent);
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes);
  const totalBytes = useUpdateStore((s) => s.totalBytes);
  const needsPermission = useUpdateStore((s) => s.needsPermission);
  const error = useUpdateStore((s) => s.error);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const downloadUpdate = useUpdateStore((s) => s.downloadUpdate);
  const installDownloadedApk = useUpdateStore((s) => s.installDownloadedApk);

  return (
    <div className="k-update-section" data-testid="settings-update-section">
      <div className="k-update-section__row">
        <div className="k-update-section__status">
          <span className="k-label-large">版本更新</span>
          <span className="k-body-small k-muted" data-testid="update-status-text">
            {status === 'checking' && '正在检查 GitHub Releases 最新版本…'}
            {status === 'up-to-date' && `当前已是最新版本 (v${host.info.version})`}
            {status === 'available' && release && `发现新版本 v${release.version}（当前 v${host.info.version}）`}
            {status === 'downloading' &&
              `正在下载 v${release?.version ?? ''}… ${progressPercent > 0 ? `${progressPercent}%` : ''}`}
            {status === 'ready-to-install' &&
              (needsPermission ? '已下载完成，请允许安装未知应用后点击安装' : `v${release?.version ?? ''} 已下载就绪`)}
            {status === 'error' && `检查或下载失败：${error ?? '未知错误'}`}
            {status === 'idle' && `当前版本 v${host.info.version} · 自动检查 GitHub Releases 更新`}
          </span>
        </div>
        <div className="k-update-section__buttons">
          <Button
            variant="tonal"
            disabled={status === 'checking' || status === 'downloading'}
            onClick={() => void checkForUpdate(host, { silent: false })}
            data-testid="check-update-btn"
          >
            {status === 'checking' ? '检查中…' : '检查更新'}
          </Button>
          {(status === 'available' || (status === 'error' && release)) && release && (
            <Button
              variant="filled"
              icon="download"
              onClick={() => void downloadUpdate(host)}
              data-testid="download-update-btn"
            >
              下载并更新 v{release.version}
            </Button>
          )}
          {status === 'ready-to-install' && (
            <Button
              variant="filled"
              icon="check"
              onClick={() => void installDownloadedApk(host)}
              data-testid="install-update-btn"
            >
              安装更新
            </Button>
          )}
        </div>
      </div>
      {status === 'downloading' && (
        <div className="k-update-section__progress">
          <LinearProgress {...(progressPercent > 0 ? { value: progressPercent / 100 } : {})} />
          <span className="k-label-small k-muted">
            {downloadedBytes > 0
              ? `${formatBytes(downloadedBytes)}${totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ''}`
              : '正在连接下载源…'}
          </span>
        </div>
      )}
      {release && (status === 'available' || status === 'ready-to-install') && release.notes && (
        <details className="k-update-section__notes" data-testid="update-release-notes">
          <summary className="k-label-medium">v{release.version} 更新日志</summary>
          <pre className="k-body-small k-update-section__notes-body">{release.notes}</pre>
        </details>
      )}
    </div>
  );
}
