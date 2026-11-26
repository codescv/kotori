/**
 * Top notification banner when a newer Kotori version is available or
 * downloading, plus the Settings "About & Update" action block.
 *
 * v0.1.34: one tap on 「立即更新」 / 「下载并安装」 downloads, verifies and launches
 * the system installer directly; 「安装更新」 only remains as a re-trigger in case
 * the user dismissed the installer (or to retry after granting permission).
 */
import { Button } from '../../components/m3/Button';
import { IconButton } from '../../components/m3/IconButton';
import { LinearProgress } from '../../components/m3/Progress';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
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
  const t = useT();
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
    <div className="k-update-banner" role="region" aria-label={t('updater.bannerAria')} data-testid="update-banner">
      <div className="k-update-banner__main">
        <div className="k-update-banner__title-row">
          <span className="k-update-banner__badge">{t('updater.badgeNew')}</span>
          <strong className="k-title-small">
            {t('updater.newVersionTitle', { version: release.version })}
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
              {t('updater.downloadingPkg')} {progressPercent > 0 ? `${progressPercent}%` : ''}{' '}
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
            {t('updater.updateNow')}
          </Button>
        )}
        {status === 'ready-to-install' && (
          <Button
            variant="filled"
            icon="check"
            onClick={() => void installDownloadedApk(host)}
            data-testid="update-banner-install"
          >
            {needsPermission ? t('updater.grantAndInstall') : t('updater.installUpdate')}
          </Button>
        )}
        {status !== 'downloading' && (
          <IconButton
            icon="close"
            label={t('updater.remindLater')}
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
  const t = useT();
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
          <span className="k-label-large">{t('updater.sectionTitle')}</span>
          <span className="k-body-small k-muted" data-testid="update-status-text">
            {status === 'checking' && t('updater.statusChecking')}
            {status === 'up-to-date' && t('updater.statusUpToDate', { version: host.info.version })}
            {status === 'available' && release && t('updater.statusAvailable', { version: release.version, current: host.info.version })}
            {status === 'downloading' &&
              t('updater.statusDownloading', {
                version: release?.version ?? '',
                percent: progressPercent > 0 ? `${progressPercent}%` : '',
              }).trim()}
            {status === 'ready-to-install' &&
              (needsPermission
                ? t('updater.statusNeedsPermission')
                : t('updater.statusReadyToInstall', { version: release?.version ?? '' }))}
            {status === 'error' && t('updater.statusError', { message: error ?? t('updater.unknownError') })}
            {status === 'idle' && t('updater.statusIdle', { version: host.info.version })}
          </span>
        </div>
        <div className="k-update-section__buttons">
          <Button
            variant="tonal"
            disabled={status === 'checking' || status === 'downloading'}
            onClick={() => void checkForUpdate(host, { silent: false })}
            data-testid="check-update-btn"
          >
            {status === 'checking' ? t('updater.checkingBtn') : t('updater.checkBtn')}
          </Button>
          {(status === 'available' || (status === 'error' && release)) && release && (
            <Button
              variant="filled"
              icon="download"
              onClick={() => void downloadUpdate(host)}
              data-testid="download-update-btn"
            >
              {t('updater.downloadAndInstallBtn', { version: release.version })}
            </Button>
          )}
          {status === 'ready-to-install' && (
            <Button
              variant="filled"
              icon="check"
              onClick={() => void installDownloadedApk(host)}
              data-testid="install-update-btn"
            >
              {t('updater.installUpdate')}
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
              : t('updater.connecting')}
          </span>
        </div>
      )}
      {release && (status === 'available' || status === 'ready-to-install') && release.notes && (
        <details className="k-update-section__notes" data-testid="update-release-notes">
          <summary className="k-label-medium">{t('updater.releaseNotes', { version: release.version })}</summary>
          <pre className="k-body-small k-update-section__notes-body">{release.notes}</pre>
        </details>
      )}
    </div>
  );
}
