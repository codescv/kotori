/**
 * Server-side path browser (desktop `files.listDirectory`) with a fallback to
 * native pickers (`files.pickDirectory` / `files.pickFiles`, Android SAF).
 * Shared by the anime/manga import dialogs and the library settings.
 */
import { useEffect, useState } from 'react';
import type { DirectoryEntry } from '@kotori/core';
import { useHost } from '../host/HostContext';
import { useT } from '../i18n';
import { Button } from './m3/Button';
import { cx } from './m3/cx';
import { Icon } from './m3/Icon';
import { IconButton } from './m3/IconButton';
import { CircularProgress } from './m3/Progress';

export interface PathBrowserProps {
  /** Currently chosen path (highlighted). */
  readonly value: string;
  readonly onChange: (path: string) => void;
  /** Which entries can be chosen. */
  readonly select: 'dir' | 'file' | 'any';
  /** Lower-case extensions (without dot) offered for `file`/`any`, e.g. `['mokuro','cbz','zip']`. */
  readonly accept?: readonly string[];
  readonly className?: string | undefined;
}

const extOf = (name: string): string => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

export function PathBrowser({ value, onChange, select, accept, className }: PathBrowserProps) {
  const host = useHost();
  const t = useT();
  const caps = host.info.capabilities;
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<{ path: string; parent?: string | undefined; entries: readonly DirectoryEntry[] } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const list = host.files.listDirectory;
    if (!caps.pathBrowser || !list) return;
    let alive = true;
    setLoading(true);
    list(cwd)
      .then((l) => {
        if (!alive) return;
        setListing(l);
        setError(undefined);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [host, caps.pathBrowser, cwd]);

  if (!caps.pathBrowser || !host.files.listDirectory) {
    const pickDir = host.files.pickDirectory;
    const pickFiles = host.files.pickFiles;
    return (
      <div className={cx('k-path-browser k-path-browser--picker', className)}>
        <div className="k-row">
          {select !== 'file' && caps.directoryPicker && pickDir && (
            <Button variant="tonal" icon="folder" onClick={() => void pickDir().then((p) => p && onChange(p))}>
              {t('anime.import.pick')}
            </Button>
          )}
          {select !== 'dir' && caps.filePicker && pickFiles && (
            <Button variant="tonal" icon="file" onClick={() => void pickFiles({ ...(accept ? { accept: accept.map((a) => `.${a}`) } : {}), multiple: false }).then((ps) => ps[0] && onChange(ps[0]))}>
              {t('common.browse')}
            </Button>
          )}
        </div>
        {value && (
          <p className="k-path-browser__chosen" data-testid="path-chosen">
            {value}
          </p>
        )}
      </div>
    );
  }

  const selectable = (e: DirectoryEntry): boolean =>
    select === 'any' ? e.kind === 'dir' || !accept || accept.includes(extOf(e.name)) : select === 'dir' ? e.kind === 'dir' : e.kind === 'file' && (!accept || accept.includes(extOf(e.name)));

  return (
    <div className={cx('k-path-browser', className)}>
      <div className="k-path-browser__bar">
        <IconButton icon="back" label={t('common.up')} size="small" disabled={!listing?.parent} onClick={() => listing?.parent && setCwd(listing.parent)} />
        <code className="k-path-browser__cwd" title={listing?.path}>
          {listing?.path ?? '…'}
        </code>
        {select !== 'file' && listing && (
          <Button variant="text" onClick={() => onChange(listing.path)}>
            {t('common.selectThisFolder')}
          </Button>
        )}
      </div>
      {error && <p className="k-error-text">{error}</p>}
      <ul className="k-path-browser__list" aria-busy={loading}>
        {loading && !listing && (
          <li className="k-path-browser__loading">
            <CircularProgress size={24} />
          </li>
        )}
        {listing?.entries.map((e) => {
          const can = selectable(e);
          return (
            <li key={e.path}>
              <button
                type="button"
                className={cx('k-path-browser__entry', value === e.path && 'is-selected', !can && e.kind === 'file' && 'is-disabled')}
                disabled={!can && e.kind === 'file'}
                onClick={() => (can ? onChange(e.path) : undefined)}
                onDoubleClick={() => e.kind === 'dir' && setCwd(e.path)}
              >
                <Icon name={e.kind === 'dir' ? 'folder' : 'file'} size={20} />
                <span className="k-path-browser__name">{e.name}</span>
                {e.kind === 'dir' && (
                  <span
                    role="button"
                    tabIndex={-1}
                    className="k-path-browser__open"
                    aria-label={t('common.open')}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setCwd(e.path);
                    }}
                  >
                    <Icon name="chevronRight" size={20} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {value && (
        <p className="k-path-browser__chosen" data-testid="path-chosen">
          {t('common.path')}: <code>{value}</code>
        </p>
      )}
    </div>
  );
}
