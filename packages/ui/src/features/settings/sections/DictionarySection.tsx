/**
 * Settings → 词典与查词 (spec §5.2): installed dictionaries (kind badge,
 * revision, counts, attribution, enable switch, priority ↑/↓, delete), a
 * neutral "import local Yomitan v3 .zip" button, and the open recommended
 * catalogue (`RECOMMENDED_DICT_PRESETS`) with licence + verbatim attribution.
 * Commercial dictionaries are never named or linked.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { RECOMMENDED_DICT_PRESETS, type DictionaryInfo, type RecommendedDictPreset } from '@kotori/core';
import { Button } from '../../../components/m3/Button';
import { LinearProgress } from '../../../components/m3/Progress';
import { Switch } from '../../../components/m3/Switch';
import { useHost } from '../../../host/HostContext';
import { useHostEvent } from '../../../host/useHostEvents';
import { useT, type Translate } from '../../../i18n';
import { useDictStore, type DictImportProgress } from '../../../stores/dict';
import { showSnackbar } from '../../../stores/snackbar';
import { cx } from '../../../components/m3/cx';

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(file);
  });
}

function ProgressRow({ id, p, t, onClear }: { readonly id: string; readonly p: DictImportProgress; readonly t: Translate; readonly onClear: () => void }) {
  const label =
    p.phase === 'downloading'
      ? t('settings.dict.progress.downloading')
      : p.phase === 'importing'
        ? t('settings.dict.progress.importing', { rows: p.processedRows.toLocaleString('en-US') })
        : p.phase === 'ready'
          ? t('settings.dict.progress.ready')
          : t('settings.dict.progress.failed', { error: p.error ?? '' });
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
        <span className="k-label-large">{preset.title}</span>
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
  const fileRef = useRef<HTMLInputElement>(null);

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
  const openGuide = (preset: RecommendedDictPreset): void => {
    if (host.files.openExternal) void host.files.openExternal(preset.downloadUrl);
    else if (typeof window !== 'undefined') window.open(preset.downloadUrl, '_blank', 'noopener');
  };
  const sorted = [...dictionaries].sort((a, b) => a.priority - b.priority);
  const progressEntries = Object.entries(progress);
  const busyIds = new Set(progressEntries.filter(([, p]) => p.phase === 'downloading' || p.phase === 'importing').map(([id]) => id));

  return (
    <div className="k-settings-field k-dict-settings" data-testid="settings-dictionary-section">
      <p className="k-body-small k-muted">{t('settings.dict.intro')}</p>

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

      {progressEntries.length > 0 && (
        <div className="k-dict-settings__block" data-testid="dict-import-progress">
          {progressEntries.map(([id, p]) => (
            <ProgressRow key={id} id={id} p={p} t={t} onClear={() => store.clearProgress(id)} />
          ))}
        </div>
      )}

      <div className="k-dict-settings__block">
        <div className="k-row">
          <Button variant="tonal" icon="upload" data-testid="dict-import-zip-btn" onClick={() => void pickZip()}>
            {t('settings.dict.importLocal')}
          </Button>
        </div>
        <input ref={fileRef} type="file" accept=".zip,application/zip" hidden data-testid="dict-import-zip-input" onChange={(e) => void onFile(e)} />
        <p className="k-body-small k-muted">{t('settings.dict.importLocalHelp')}</p>
      </div>

      <div className="k-dict-settings__block">
        <span className="k-label-large">{t('settings.dict.presets')}</span>
        <ul className="k-dict-list" data-testid="dict-presets">
          {RECOMMENDED_DICT_PRESETS.map((p) => (
            <PresetRow
              key={p.id}
              preset={p}
              installed={dictionaries.some((d) => d.id === p.id)}
              busy={busyIds.has(p.id)}
              t={t}
              onInstall={() => void installPreset(p)}
              onGuide={() => openGuide(p)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
