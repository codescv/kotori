/**
 * mokuro.moe catalog browser: breadcrumbs, search filter, sort chips, rich
 * series cards with 5:7 cover art & community metadata, and importable volumes.
 */
import { useEffect, useMemo, useState } from 'react';
import type { MokuroCatalogEntry, MokuroCatalogListing, MokuroCatalogVolume } from '@kotori/core';
import { Button } from '../../components/m3/Button';
import { Chip } from '../../components/m3/Chip';
import { Icon } from '../../components/m3/Icon';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { CoverThumb } from './CoverThumb';
import { formatBytes, formatCharCount } from './format';
import { useDownloadsStore } from './useDownloadsStore';

type SeriesSort = 'default' | 'score' | 'volumes' | 'chars';

function matchesSeriesQuery(d: MokuroCatalogEntry, q: string): boolean {
  if (d.name.toLowerCase().includes(q)) return true;
  if (d.nativeTitle?.toLowerCase().includes(q)) return true;
  if (d.romajiTitle?.toLowerCase().includes(q)) return true;
  if (d.englishTitle?.toLowerCase().includes(q)) return true;
  if (d.sizeText?.toLowerCase().includes(q)) return true;
  if (d.genres?.some((g) => g.toLowerCase().includes(q))) return true;
  if (d.tags?.some((t) => t.toLowerCase().includes(q))) return true;
  return false;
}

export function MokuroCatalogBrowser() {
  const host = useHost();
  const t = useT();
  const upsert = useDownloadsStore((s) => s.upsert);
  const root = useSettingsStore((s) => s.settings.downloads.mokuroCatalogUrl);
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SeriesSort>('default');
  const [listing, setListing] = useState<MokuroCatalogListing | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    setFilter('');
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
    if (depth === 0) return undefined;
    if (listing.url.includes('/catalog/api/series')) return listing.url;
    const base = root.endsWith('/') ? root : `${root}/`;
    return base + listing.path.slice(0, depth).map((p) => `${encodeURIComponent(p)}/`).join('');
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

  const q = filter.trim().toLowerCase();
  const dirs = useMemo(() => {
    const all = listing?.entries.filter((e) => e.kind === 'dir') ?? [];
    const filtered = q ? all.filter((d) => matchesSeriesQuery(d, q)) : all;
    if (sort === 'default') return filtered;
    return [...filtered].sort((a, b) => {
      if (sort === 'score') return (b.score ?? -1) - (a.score ?? -1);
      if (sort === 'volumes') return (b.volumeCount ?? 0) - (a.volumeCount ?? 0);
      if (sort === 'chars') return (b.totalChars ?? 0) - (a.totalChars ?? 0);
      return 0;
    });
  }, [listing, q, sort]);

  const volumes = useMemo(() => {
    const all = listing?.volumes ?? [];
    if (!q) return all;
    return all.filter((v) => v.name.toLowerCase().includes(q));
  }, [listing, q]);

  const seriesName = listing?.path[listing.path.length - 1];
  const seriesCover = listing?.coverUrl ?? volumes[0]?.coverUrl;
  const seriesTotalPages = useMemo(() => volumes.reduce((acc, v) => acc + (v.pageCount ?? 0), 0), [volumes]);

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
      <div className="k-dl-search__bar">
        <TextField leadingIcon="search" label={t('downloads.mokuro.search')} value={filter} onValueChange={setFilter} />
      </div>
      {dirs.length > 1 && volumes.length === 0 && (
        <div className="k-row k-dl-sort-bar">
          <Chip kind="filter" selected={sort === 'default'} onClick={() => setSort('default')}>
            默认排序
          </Chip>
          <Chip kind="filter" selected={sort === 'score'} onClick={() => setSort('score')}>
            评分最高
          </Chip>
          <Chip kind="filter" selected={sort === 'volumes'} onClick={() => setSort('volumes')}>
            卷数最多
          </Chip>
          <Chip kind="filter" selected={sort === 'chars'} onClick={() => setSort('chars')}>
            字数最多
          </Chip>
          <span className="k-dl-count-badge">{dirs.length} 部漫画</span>
        </div>
      )}
      {loading && <LinearProgress label={t('common.loading')} />}
      {error && <p className="k-error-text">{t('common.error', { message: error })}</p>}
      {listing && volumes.length > 0 && (
        <>
          {seriesName && (
            <div className="k-dl-banner">
              <CoverThumb src={seriesCover} alt={seriesName} fallbackIcon="book" size="lg" />
              <div className="k-dl-banner__info">
                <h3 className="k-dl-banner__title">{seriesName}</h3>
                <div className="k-dl-media-card__badges">
                  <span className="k-tag">{volumes.length} 卷</span>
                  {seriesTotalPages > 0 && <span className="k-tag k-tag--muted">共 {seriesTotalPages.toLocaleString()} 页</span>}
                  <span className="k-tag k-tag--tone">内置 OCR (.mokuro + CBZ)</span>
                </div>
              </div>
            </div>
          )}
          <h3 className="k-title-small k-muted">{t('downloads.mokuro.volumes')}</h3>
          <div className="k-dl-media-list">
            {volumes.map((v) => (
              <div key={v.mokuroUrl} className="k-dl-volume-card">
                <CoverThumb src={v.coverUrl ?? seriesCover} alt={v.name} fallbackIcon="book" size="sm" />
                <div className="k-dl-media-card__body">
                  <div className="k-dl-media-card__title">{v.name}</div>
                  <div className="k-dl-media-card__badges">
                    <span className="k-tag k-tag--muted">.mokuro + {v.imagesKind === 'archive' ? 'cbz/zip' : 'dir'}</span>
                    {v.pageCount !== undefined && <span className="k-tag">{v.pageCount} 页</span>}
                    {v.sizeBytes !== undefined && <span className="k-tag k-tag--muted">{formatBytes(v.sizeBytes)}</span>}
                  </div>
                </div>
                <div className="k-dl-media-card__actions">
                  <Button
                    variant={started.has(v.mokuroUrl) ? 'tonal' : 'filled'}
                    icon={started.has(v.mokuroUrl) ? 'check' : 'download'}
                    disabled={started.has(v.mokuroUrl)}
                    onClick={() => void download(v)}
                  >
                    {t('downloads.mokuro.download')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {dirs.length > 0 && (
        <div className="k-dl-media-list">
          {dirs.map((d) => {
            const primaryTitle = d.nativeTitle && d.nativeTitle !== d.name ? `${d.nativeTitle} · ${d.name}` : d.name;
            const subTitles = [
              d.romajiTitle && d.romajiTitle !== d.name ? d.romajiTitle : undefined,
              d.englishTitle && d.englishTitle !== d.name && d.englishTitle !== d.romajiTitle ? d.englishTitle : undefined,
            ].filter((x): x is string => Boolean(x));
            const chips = [...(d.genres ?? []).slice(0, 3), ...(d.tags ?? []).slice(0, 2)];
            const charLabel = formatCharCount(d.totalChars);
            const hasRichMeta = d.score !== undefined || d.volumeCount !== undefined || d.totalPages !== undefined || Boolean(charLabel);

            return (
              <button key={d.url} type="button" className="k-dl-media-card" onClick={() => setUrl(d.url)}>
                <CoverThumb src={d.coverUrl} alt={d.nativeTitle ?? d.name} fallbackIcon="book" size="md" />
                <div className="k-dl-media-card__body">
                  <div className="k-dl-media-card__title">{primaryTitle}</div>
                  {subTitles.length > 0 && <div className="k-dl-media-card__subtitle">{subTitles.join(' · ')}</div>}
                  <div className="k-dl-media-card__badges">
                    {d.score !== undefined && <span className="k-tag k-tag--tone">★ {d.score}%</span>}
                    {d.volumeCount !== undefined && <span className="k-tag">{d.volumeCount} 卷</span>}
                    {d.totalPages !== undefined && <span className="k-tag k-tag--muted">{d.totalPages.toLocaleString()} 页</span>}
                    {charLabel && <span className="k-tag k-tag--muted">{charLabel}</span>}
                    {!hasRichMeta && d.sizeText && <span className="k-dl-media-card__sub">{d.sizeText}</span>}
                  </div>
                  {chips.length > 0 && (
                    <div className="k-dl-media-card__chips">
                      {chips.map((c) => (
                        <span key={c} className="k-dl-chip">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="k-dl-media-card__chevron" aria-hidden="true">
                  <Icon name="chevronRight" />
                </span>
              </button>
            );
          })}
        </div>
      )}
      {listing && !loading && dirs.length === 0 && volumes.length === 0 && <p className="k-empty">{t('downloads.noResults')}</p>}
    </section>
  );
}
