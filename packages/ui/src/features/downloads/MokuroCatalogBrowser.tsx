/** mokuro.moe catalog browser: breadcrumbs, directories, and importable volumes. */
import { useEffect, useState } from 'react';
import type { MokuroCatalogListing, MokuroCatalogVolume } from '@kotori/core';
import { Button } from '../../components/m3/Button';
import { Icon } from '../../components/m3/Icon';
import { List, ListItem } from '../../components/m3/List';
import { LinearProgress } from '../../components/m3/Progress';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { formatBytes } from './format';
import { useDownloadsStore } from './useDownloadsStore';

export function MokuroCatalogBrowser() {
  const host = useHost();
  const t = useT();
  const upsert = useDownloadsStore((s) => s.upsert);
  const root = useSettingsStore((s) => s.settings.downloads.mokuroCatalogUrl);
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<MokuroCatalogListing | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    host.downloads
      .browseMokuroCatalog(url)
      .then((l) => alive && setListing(l))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [host, url]);

  const crumbUrl = (depth: number): string | undefined => {
    if (!listing) return undefined;
    const base = root.endsWith('/') ? root : `${root}/`;
    return depth === 0 ? undefined : base + listing.path.slice(0, depth).map((p) => `${encodeURIComponent(p)}/`).join('');
  };

  const download = async (v: MokuroCatalogVolume): Promise<void> => {
    try {
      const task = await host.downloads.start({ source: { kind: 'mokuro-moe', volume: v }, title: v.name, autoImport: true });
      upsert(task);
      setStarted((s) => new Set(s).add(v.mokuroUrl));
      showSnackbar(t('downloads.nyaa.started', { title: v.name }));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };

  const dirs = listing?.entries.filter((e) => e.kind === 'dir') ?? [];
  return (
    <section className="k-dl-search">
      <nav className="k-dl-crumbs" aria-label={t('downloads.mokuro.root')}>
        <button type="button" className="k-dl-crumb" onClick={() => setUrl(undefined)}>
          mokuro.moe
        </button>
        {listing?.path.map((p, i) => (
          <span key={`${i}-${p}`} className="k-row">
            <Icon name="chevronRight" size={18} />
            <button type="button" className="k-dl-crumb" onClick={() => setUrl(crumbUrl(i + 1))}>
              {p}
            </button>
          </span>
        ))}
      </nav>
      {loading && <LinearProgress label={t('common.loading')} />}
      {error && <p className="k-error-text">{t('common.error', { message: error })}</p>}
      {listing && listing.volumes.length > 0 && (
        <>
          <h3 className="k-title-small k-muted">{t('downloads.mokuro.volumes')}</h3>
          <List>
            {listing.volumes.map((v) => (
              <ListItem
                key={v.mokuroUrl}
                leading={<Icon name="book" />}
                headline={v.name}
                supporting={`.mokuro + ${v.imagesKind === 'archive' ? 'zip' : 'dir'} · ${formatBytes(v.sizeBytes)}`}
                trailing={
                  <Button variant={started.has(v.mokuroUrl) ? 'tonal' : 'filled'} icon={started.has(v.mokuroUrl) ? 'check' : 'download'} disabled={started.has(v.mokuroUrl)} onClick={() => void download(v)}>
                    {t('downloads.mokuro.download')}
                  </Button>
                }
              />
            ))}
          </List>
        </>
      )}
      {dirs.length > 0 && (
        <List>
          {dirs.map((d) => (
            <ListItem key={d.url} leading={<Icon name="folder" />} headline={d.name} trailing={<Icon name="chevronRight" />} onClick={() => setUrl(d.url)} />
          ))}
        </List>
      )}
      {listing && !loading && dirs.length === 0 && listing.volumes.length === 0 && <p className="k-empty">{t('downloads.noResults')}</p>}
    </section>
  );
}
