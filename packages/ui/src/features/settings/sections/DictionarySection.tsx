/**
 * Settings → 词典与查词 (spec §5.2):
 * - Simplified inline card showing a concise dictionary summary + a single
 *   `管理词典` button (`dict-manage-btn`).
 * - Wide management modal (`dict-manage-dialog`) containing one-click batch
 *   download of all recommended presets (`dict-install-all-presets-btn`),
 *   neutral local Yomitan v3 `.zip` import (`dict-import-zip-btn`), live
 *   import progress, installed dictionary controls (enable, priority ↑/↓,
 *   two-step delete), and the open recommended catalogue with licence +
 *   verbatim attribution. Commercial dictionaries are never named or linked.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { RECOMMENDED_DICT_PRESETS, type DictionaryInfo, type RecommendedDictPreset } from '@kotori/core';
import { useBackInterceptor } from '../../../app/routes';
import { Button } from '../../../components/m3/Button';
import { cx } from '../../../components/m3/cx';
import { Dialog } from '../../../components/m3/Dialog';
import { LinearProgress } from '../../../components/m3/Progress';
import { Switch } from '../../../components/m3/Switch';
import { useHost } from '../../../host/HostContext';
import { useHostEvent } from '../../../host/useHostEvents';
import { useT, type Translate } from '../../../i18n';
import { useDictStore, type DictImportProgress } from '../../../stores/dict';
import { showSnackbar } from '../../../stores/snackbar';

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(file);
  });
}

function progressLabelOf(p: DictImportProgress, t: Translate): string {
  return p.phase === 'downloading'
    ? t('settings.dict.progress.downloading')
    : p.phase === 'importing'
      ? t('settings.dict.progress.importing', { rows: p.processedRows.toLocaleString('en-US') })
      : p.phase === 'ready'
        ? t('settings.dict.progress.ready')
        : t('settings.dict.progress.failed', { error: p.error ?? '' });
}

function ProgressRow({ id, p, t, onClear }: { readonly id: string; readonly p: DictImportProgress; readonly t: Translate; readonly onClear: () => void }) {
  const label = progressLabelOf(p, t);
  const busy = p.phase === 'downloading' || p.phase === 'importing';
  return (
    <div className={cx('k-dict-progress', `is-${p.phase}`)} data-testid={`dict-import-progress-${id}`} data-phase={p.phase} role="status">
      <div className="k-row">
        <span className="k-label-large">{p.title}</span>
        <span className="k-muted k-body-small">{label}</span>
        <span className="k-spacer" />
        {!busy && (
          <button type="button" className="k-dict-row__btn" aria-label="✕" onClick={onClear}>
            ✕
          </button>
        )}
      </div>
      {busy && <LinearProgress label={label} />}
    </div>
  );
}

function InstalledRow({
  d,
  index,
  count,
  t,
  onToggle,
  onMove,
  onRemove,
}: {
  readonly d: DictionaryInfo;
  readonly index: number;
  readonly count: number;
  readonly t: Translate;
  readonly onToggle: (enabled: boolean) => void;
  readonly onMove: (dir: 'up' | 'down') => void;
  readonly onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className={cx('k-dict-row', !d.enabled && 'is-disabled')} data-testid={`dict-row-${d.id}`}>
      <div className="k-dict-row__main">
        <div className="k-row">
          <span className="k-label-large k-dict-row__title">{d.title}</span>
          <span className={cx('k-dict-kind', `k-dict-kind--${d.kind}`)} data-testid={`dict-kind-${d.id}`}>
            {t(`settings.dict.kind.${d.kind}`)}
          </span>
          {d.status === 'importing' && <span className="k-tag k-tag--muted">{t('settings.dict.importing')}</span>}
        </div>
        <div className="k-body-small k-muted">
          {t('settings.dict.revision', { revision: d.revision })}
          {d.termCount > 0 && ` · ${t('settings.dict.termCount', { count: d.termCount.toLocaleString('en-US') })}`}
          {d.metaCount > 0 && ` · ${t('settings.dict.metaCount', { count: d.metaCount.toLocaleString('en-US') })}`}
        </div>
        {d.attribution && <div className="k-body-small k-muted k-dict-attr">{t('settings.dict.attribution', { text: d.attribution })}</div>}
      </div>
      <div className="k-dict-row__actions">
        <Switch checked={d.enabled} onChange={onToggle} label={t('settings.dict.enabled')} />
        <button type="button" className="k-dict-row__btn" data-testid={`dict-up-${d.id}`} title={t('settings.dict.up')} aria-label={t('settings.dict.up')} disabled={index === 0} onClick={() => onMove('up')}>
          ↑
        </button>
        <button
          type="button"
          className="k-dict-row__btn"
          data-testid={`dict-down-${d.id}`}
          title={t('settings.dict.down')}
          aria-label={t('settings.dict.down')}
          disabled={index === count - 1}
          onClick={() => onMove('down')}
        >
          ↓
        </button>
        <Button
          variant={confirming ? 'filled' : 'text'}
          icon="delete"
          data-testid={`dict-remove-${d.id}`}
          className={cx(confirming && 'k-btn--danger')}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            setConfirming(false);
            onRemove();
          }}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? t('settings.dict.removeConfirm') : t('settings.dict.remove')}
        </Button>
      </div>
    </li>
  );
}

function PresetRow({
  preset,
  installed,
  busy,
  t,
  onInstall,
  onGuide,
}: {
  readonly preset: RecommendedDictPreset;
  readonly installed: boolean;
  readonly busy: boolean;
  readonly t: Translate;
  readonly onInstall: () => void;
  readonly onGuide: () => void;
}) {
  return (
    <li className="k-dict-preset" data-testid={`dict-preset-${preset.id}`}>
      <div className="k-row">
        <span className="k-label-large k-dict-preset__title">{preset.title}</span>
        <span className={cx('k-dict-kind', `k-dict-kind--${preset.kind}`)}>{t(`settings.dict.kind.${preset.kind}`)}</span>
        <span className="k-tag k-tag--muted">{preset.sizeLabel}</span>
        <span className={cx('k-dict-license', preset.externalOnly && 'is-external')} data-testid={`dict-license-${preset.id}`}>
          {preset.license}
        </span>
        {installed && <span className="k-tag">{t('settings.dict.installedBadge')}</span>}
      </div>
      <p className="k-body-small k-dict-preset__desc">{preset.description}</p>
      <p className="k-body-small k-muted k-dict-attr" data-testid={`dict-attribution-${preset.id}`}>
        {t('settings.dict.attribution', { text: preset.attribution })}
      </p>
      {preset.externalOnly && <p className="k-body-small k-muted">{t('settings.dict.externalHelp')}</p>}
      <div className="k-row">
        {preset.externalOnly && (
          <Button variant="outlined" icon="link" data-testid={`dict-preset-guide-${preset.id}`} onClick={onGuide}>
            {t('settings.dict.externalGuide')}
          </Button>
        )}
        <Button variant={installed ? 'text' : 'tonal'} icon="download" disabled={busy} data-testid={`dict-preset-install-${preset.id}`} onClick={onInstall}>
          {installed ? t('settings.dict.reinstall') : preset.externalOnly ? t('settings.dict.externalImport') : t('settings.dict.install')}
        </Button>
      </div>
    </li>
  );
}

export function DictionarySection() {
  const t = useT();
  const host = useHost();
  const dictionaries = useDictStore((s) => s.dictionaries);
  const progress = useDictStore((s) => s.importProgress);
  const installingAll = useDictStore((s) => s.installingAllPresets);
  const [manageOpen, setManageOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useBackInterceptor(
    () => {
      if (manageOpen) {
        setManageOpen(false);
        return true;
      }
      return false;
    },
    manageOpen,
  );

  useEffect(() => {
    void useDictStore
      .getState()
      .load(host)
      .catch(() => {});
  }, [host]);
  useHostEvent('dict-import-progress', (e) => useDictStore.getState().handleEvent(host, e));

  if (!host.dict) {
    return (
      <div className="k-settings-field" data-testid="settings-dictionary-section">
        <p className="k-muted k-body-medium">{t('settings.dict.unsupported')}</p>
      </div>
    );
  }

  const store = useDictStore.getState();
  const report = (info: DictionaryInfo | undefined, key: string): void => {
    if (info) showSnackbar(t('settings.dict.imported', { title: info.title }));
    else {
      const err = useDictStore.getState().importProgress[key]?.error ?? '';
      showSnackbar(t('settings.dict.importFailed', { message: err }), { tone: 'error' });
    }
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const bytes = await readFileBytes(file);
      report(await store.importZipBytes(host, file.name, bytes), `file:${file.name}`);
    } catch (err) {
      showSnackbar(t('settings.dict.importFailed', { message: err instanceof Error ? err.message : String(err) }), { tone: 'error' });
    } finally {
      input.value = '';
    }
  };
  const pickZip = async (): Promise<void> => {
    const input = fileRef.current;
    if (input && typeof input.click === 'function') {
      input.click();
      return;
    }
    // Fallback: native picker returning a host path / content URI.
    const paths = (await host.files.pickFiles?.({ accept: ['.zip', 'application/zip'] })) ?? [];
    const path = paths[0];
    if (!path) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    report(await store.importFilePath(host, path), `file:${name}`);
  };
  const installPreset = async (preset: RecommendedDictPreset): Promise<void> => {
    report(await store.importPreset(host, preset.id), preset.id);
  };
  const installAllPresets = async (): Promise<void> => {
    const imported = await store.importAllPresets(host);
    if (imported.length > 0) {
      showSnackbar(t('settings.dict.installedAll', { count: imported.length }));
    } else {
      const failed = Object.values(useDictStore.getState().importProgress).find((p) => p.phase === 'failed');
      if (failed) showSnackbar(t('settings.dict.importFailed', { message: failed.error ?? '' }), { tone: 'error' });
    }
  };
  const openGuide = (preset: RecommendedDictPreset): void => {
    if (host.files.openExternal) void host.files.openExternal(preset.downloadUrl);
    else if (typeof window !== 'undefined') window.open(preset.downloadUrl, '_blank', 'noopener');
  };

  const sorted = [...dictionaries].sort((a, b) => a.priority - b.priority);
  const enabledCount = sorted.filter((d) => d.enabled).length;
  const progressEntries = Object.entries(progress);
  const activeProgress = progressEntries.filter(([, p]) => p.phase === 'downloading' || p.phase === 'importing');
  const busyIds = new Set(activeProgress.map(([id]) => id));
  const installedPresetCount = RECOMMENDED_DICT_PRESETS.filter((p) => dictionaries.some((d) => d.id === p.id && d.status === 'ready')).length;
  const missingPresetCount = RECOMMENDED_DICT_PRESETS.length - installedPresetCount;
  const installAllLabel = installingAll
    ? t('settings.dict.installingAll')
    : missingPresetCount === 0
      ? t('settings.dict.installAllDone')
      : installedPresetCount === 0
        ? t('settings.dict.installAll')
        : t('settings.dict.installAllRemaining', { count: missingPresetCount });
  const activeSummary = activeProgress[0] ? `${activeProgress[0][1].title} · ${progressLabelOf(activeProgress[0][1], t)}` : t('settings.dict.installingAll');

  return (
    <div className="k-settings-field k-dict-settings" data-testid="settings-dictionary-section">
      <div className="k-dict-summary" data-testid="dict-summary">
        {sorted.length === 0 ? (
          <p className="k-body-medium k-muted k-dict-summary__text">{t('settings.dict.summaryEmpty')}</p>
        ) : (
          <>
            <p className="k-body-medium k-dict-summary__text">{t('settings.dict.summaryCount', { total: sorted.length, enabled: enabledCount })}</p>
            <div className="k-dict-summary__chips">
              {sorted.map((d) => (
                <span key={d.id} className={cx('k-dict-summary__chip', !d.enabled && 'is-disabled')}>
                  <span className={cx('k-dict-kind', `k-dict-kind--${d.kind}`)}>{t(`settings.dict.kind.${d.kind}`)}</span>
                  <span className="k-dict-summary__chip-title">{d.title}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {busyIds.size > 0 && (
        <div className="k-dict-card-progress" data-testid="dict-card-progress" role="status">
          <span className="k-body-small k-muted">{installingAll ? t('settings.dict.installingAll') : activeSummary}</span>
          <LinearProgress label={activeSummary} />
        </div>
      )}

      <div className="k-row">
        <Button variant="tonal" icon="book" data-testid="dict-manage-btn" onClick={() => setManageOpen(true)}>
          {t('settings.dict.manage')}
        </Button>
      </div>

      <Dialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        title={t('settings.dict.manageTitle')}
        wide
        className="k-dict-manage-modal"
        actions={
          <Button variant="text" data-testid="dict-manage-close-btn" onClick={() => setManageOpen(false)}>
            {t('common.close')}
          </Button>
        }
      >
        <div className="k-dict-manage" data-testid="dict-manage-dialog">
          <p className="k-body-small k-muted k-dict-manage__intro">{t('settings.dict.intro')}</p>

          <div className="k-dict-settings__block k-dict-manage__toolbar">
            <div className="k-dict-manage__toolbar-btns">
              <Button
                variant="filled"
                icon="download"
                disabled={installingAll || busyIds.size > 0}
                data-testid="dict-install-all-presets-btn"
                onClick={() => void installAllPresets()}
              >
                {installAllLabel}
              </Button>
              <Button variant="tonal" icon="upload" disabled={installingAll} data-testid="dict-import-zip-btn" onClick={() => void pickZip()}>
                {t('settings.dict.importLocal')}
              </Button>
            </div>
            <input ref={fileRef} type="file" accept=".zip,application/zip" hidden data-testid="dict-import-zip-input" onChange={(e) => void onFile(e)} />
            <p className="k-body-small k-muted k-dict-manage__help">{t('settings.dict.importLocalHelp')}</p>
          </div>

          {progressEntries.length > 0 && (
            <div className="k-dict-settings__block" data-testid="dict-import-progress">
              {progressEntries.map(([id, p]) => (
                <ProgressRow key={id} id={id} p={p} t={t} onClear={() => store.clearProgress(id)} />
              ))}
            </div>
          )}

          <div className="k-dict-settings__block">
            <span className="k-label-large">{t('settings.dict.installed')}</span>
            {sorted.length === 0 ? (
              <p className="k-muted k-body-medium" data-testid="dict-installed-empty">
                {t('settings.dict.none')}
              </p>
            ) : (
              <ul className="k-dict-list" data-testid="dict-installed-list">
                {sorted.map((d, i) => (
                  <InstalledRow
                    key={d.id}
                    d={d}
                    index={i}
                    count={sorted.length}
                    t={t}
                    onToggle={(enabled) => void store.toggleEnabled(host, d.id, enabled).catch((err: unknown) => showSnackbar(String(err), { tone: 'error' }))}
                    onMove={(dir) => void store.movePriority(host, d.id, dir).catch((err: unknown) => showSnackbar(String(err), { tone: 'error' }))}
                    onRemove={() =>
                      void store
                        .remove(host, d.id)
                        .then(() => showSnackbar(t('settings.dict.removed', { title: d.title })))
                        .catch((err: unknown) => showSnackbar(String(err), { tone: 'error' }))
                    }
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="k-dict-settings__block">
            <span className="k-label-large">{t('settings.dict.presets')}</span>
            <ul className="k-dict-list" data-testid="dict-presets">
              {RECOMMENDED_DICT_PRESETS.map((p) => (
                <PresetRow
                  key={p.id}
                  preset={p}
                  installed={dictionaries.some((d) => d.id === p.id)}
                  busy={installingAll || busyIds.has(p.id)}
                  t={t}
                  onInstall={() => void installPreset(p)}
                  onGuide={() => openGuide(p)}
                />
              ))}
            </ul>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
