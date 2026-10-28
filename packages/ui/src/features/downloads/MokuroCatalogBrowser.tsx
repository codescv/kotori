/**
 * mokuro.moe catalog browser: breadcrumbs, search filter, sort chips, rich
 * series cards with 5:7 cover art & community metadata, and importable volumes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { compareNatural, parseVolumeName, type MangaVolume, type MokuroCatalogEntry, type MokuroCatalogListing, type MokuroCatalogVolume } from '@kotori/core';
import { useBackInterceptor, useRouteStore } from '../../app/routes';
import { Button } from '../../components/m3/Button';
import { Chip } from '../../components/m3/Chip';
import { Icon } from '../../components/m3/Icon';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { CoverThumb } from './CoverThumb';
import { formatBytes, formatCharCount, formatDate } from './format';
import { useDownloadsStore } from './useDownloadsStore';

function normaliseVolumeKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(?:mokuro|cbz|zip)$/i, '')
    .replace(/[\s\-_【】[\]()（）]+/g, '');
}

type SeriesSort = 'default' | 'score' | 'latest' | 'volumes' | 'chars';
type VolumeSort = 'asc' | 'desc' | 'pages';

const PAGE_SIZE = 60;

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
  const [volSort, setVolSort] = useState<VolumeSort>('asc');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [listing, setListing] = useState<MokuroCatalogListing | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());
  const [libraryVolumes, setLibraryVolumes] = useState<readonly MangaVolume[]>([]);

  const reloadLibraryVolumes = useCallback(() => {
    host.manga
      .listVolumes()
      .then((list) => setLibraryVolumes(list))
      .catch(() => {});
  }, [host]);

  useEffect(() => {
    reloadLibraryVolumes();
  }, [reloadLibraryVolumes]);

  useHostEvents((e) => {
    if (
      (e.type === 'library-changed' && e.scope === 'manga') ||
      (e.type === 'download-updated' && e.task.status === 'completed' && e.task.kind === 'mokuro-volume')
    ) {
      reloadLibraryVolumes();
    }
  });

  const libraryByKey = useMemo(() => {
    const map = new Map<string, MangaVolume>();
    for (const v of libraryVolumes) {
      map.set(normaliseVolumeKey(v.title), v);
    }
    return map;
  }, [libraryVolumes]);

  const matchLibraryVolume = useCallback(
    (v: MokuroCatalogVolume): MangaVolume | undefined => libraryByKey.get(normaliseVolumeKey(v.name)),
    [libraryByKey],
  );

  /** Library volumes grouped by normalised series title (`seriesTitle` or parsed from the volume title). */
  const libraryBySeries = useMemo(() => {
    const map = new Map<string, MangaVolume[]>();
    for (const v of libraryVolumes) {
      const key = normaliseVolumeKey(v.seriesTitle ?? parseVolumeName(v.title).seriesTitle);
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(v);
      else map.set(key, [v]);
    }
    return map;
  }, [libraryVolumes]);

  /** Number of distinct library volumes belonging to a catalog series card (matched on any title alias). */
  const ownedCountForSeries = useCallback(
    (d: MokuroCatalogEntry): number => {
      if (libraryVolumes.length === 0) return 0;
      const keys = new Set(
        [d.name, d.nativeTitle, d.romajiTitle, d.englishTitle]
          .filter((x): x is string => Boolean(x && x.trim()))
          .map(normaliseVolumeKey)
          .filter(Boolean),
      );
      const ids = new Set<string>();
      for (const k of keys) for (const v of libraryBySeries.get(k) ?? []) ids.add(v.id);
      return ids.size;
    },
    [libraryBySeries, libraryVolumes.length],
  );

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, sort, url]);

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

  useBackInterceptor(
    () => {
      if (url !== undefined) {
        const depth = listing ? Math.max(0, listing.path.length - 1) : 0;
        setUrl(crumbUrl(depth));
        return true;
      }
      return false;
    },
    url !== undefined,
  );

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
    return [...filtered].sort((a, b) => {
      if (sort === 'score') {
        return (b.score ?? -1) - (a.score ?? -1) || (b.volumeCount ?? 0) - (a.volumeCount ?? 0) || compareNatural(a.name, b.name);
      }
      if (sort === 'latest') {
        return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || (b.score ?? -1) - (a.score ?? -1) || compareNatural(a.name, b.name);
      }
      if (sort === 'volumes') {
        return (b.volumeCount ?? 0) - (a.volumeCount ?? 0) || (b.score ?? -1) - (a.score ?? -1) || compareNatural(a.name, b.name);
      }
      if (sort === 'chars') {
        return (b.totalChars ?? 0) - (a.totalChars ?? 0) || (b.totalPages ?? 0) - (a.totalPages ?? 0) || compareNatural(a.name, b.name);
      }
      return compareNatural(a.name, b.name);
    });
  }, [listing, q, sort]);

  const visibleDirs = useMemo(() => dirs.slice(0, visibleCount), [dirs, visibleCount]);

  const volumes = useMemo(() => {
    const all = listing?.volumes ?? [];
    const filtered = q ? all.filter((v) => v.name.toLowerCase().includes(q)) : all;
    return [...filtered].sort((a, b) => {
      if (volSort === 'desc') return compareNatural(b.name, a.name);
      if (volSort === 'pages') return (b.pageCount ?? 0) - (a.pageCount ?? 0) || compareNatural(a.name, b.name);
      return compareNatural(a.name, b.name);
    });
  }, [listing, q, volSort]);

  const seriesName = listing?.path[listing.path.length - 1];
  const seriesCover = listing?.coverUrl ?? volumes[0]?.coverUrl;
  const seriesTotalPages = useMemo(() => volumes.reduce((acc, v) => acc + (v.pageCount ?? 0), 0), [volumes]);
  const unownedVolumes = useMemo(
    () => volumes.filter((v) => !matchLibraryVolume(v) && !started.has(v.mokuroUrl)),
    [volumes, matchLibraryVolume, started],
  );

  const downloadAllUnowned = async (): Promise<void> => {
    for (const v of unownedVolumes) {
      await download(v);
    }
  };

  const openInReader = (volumeId: string): void => {
    useRouteStore.getState().setTab('manga');
    useRouteStore.getState().openManga({ kind: 'reader', volumeId });
  };

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
          <Chip kind="filter" selected={sort === 'latest'} onClick={() => setSort('latest')}>
            最近更新
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
                {unownedVolumes.length > 1 && (
                  <div className="k-row" style={{ marginTop: 8 }}>
                    <Button
                      variant="filled"
                      icon="download"
                      onClick={() => void downloadAllUnowned()}
                      data-testid="mokuro-download-all"
                    >
                      {`一键下载全部未拥有分卷（${unownedVolumes.length} 卷）`}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          {volumes.length > 1 && (
            <div className="k-row k-dl-sort-bar">
              <Chip kind="filter" selected={volSort === 'asc'} onClick={() => setVolSort('asc')}>
                正序 (1→N)
              </Chip>
              <Chip kind="filter" selected={volSort === 'desc'} onClick={() => setVolSort('desc')}>
                倒序 (N→1)
              </Chip>
              <Chip kind="filter" selected={volSort === 'pages'} onClick={() => setVolSort('pages')}>
                页数最多
              </Chip>
            </div>
          )}
          <h3 className="k-title-small k-muted">{t('downloads.mokuro.volumes')}</h3>
          <div className="k-dl-media-list">
            {volumes.map((v) => {
              const owned = matchLibraryVolume(v);
              const parsedVol = parseVolumeName(v.name);
              const cleanVolTitle =
                seriesName && parsedVol.volumeNumber !== undefined
                  ? `${seriesName} · 第 ${parsedVol.volumeNumber} 卷`
                  : parsedVol.seriesTitle || v.name;
              return (
                <div key={v.mokuroUrl} className="k-dl-volume-card">
                  <CoverThumb src={v.coverUrl ?? seriesCover} alt={cleanVolTitle} fallbackIcon="book" size="sm" />
                  <div className="k-dl-media-card__body">
                    <div className="k-dl-media-card__title" title={v.name}>
                      {cleanVolTitle}
                    </div>
                    {cleanVolTitle !== v.name && (
                      <div className="k-dl-media-card__subtitle" title={v.name}>
                        {v.name}
                      </div>
                    )}
                    <div className="k-dl-media-card__badges">
                      <span className="k-tag k-tag--muted">.mokuro + {v.imagesKind === 'archive' ? 'cbz/zip' : 'dir'}</span>
                      {v.pageCount !== undefined && <span className="k-tag">{v.pageCount} 页</span>}
                      {v.sizeBytes !== undefined && <span className="k-tag k-tag--muted">{formatBytes(v.sizeBytes)}</span>}
                      {owned && <span className="k-tag k-tag--tone">已入库</span>}
                    </div>
                  </div>
                  <div className="k-dl-media-card__actions">
                    {owned ? (
                      <Button
                        variant="tonal"
                        icon="book"
                        onClick={() => openInReader(owned.id)}
                        data-testid="mokuro-open-library"
                      >
                        去阅读
                      </Button>
                    ) : (
                      <Button
                        variant={started.has(v.mokuroUrl) ? 'tonal' : 'filled'}
                        icon={started.has(v.mokuroUrl) ? 'check' : 'download'}
                        disabled={started.has(v.mokuroUrl)}
                        onClick={() => void download(v)}
                      >
                        {t('downloads.mokuro.download')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {visibleDirs.length > 0 && (
        <div className="k-dl-media-list">
          {visibleDirs.map((d) => {
            const primaryTitle = d.nativeTitle && d.nativeTitle !== d.name ? `${d.nativeTitle} · ${d.name}` : d.name;
            const subTitles = [
              d.romajiTitle && d.romajiTitle !== d.name ? d.romajiTitle : undefined,
              d.englishTitle && d.englishTitle !== d.name && d.englishTitle !== d.romajiTitle ? d.englishTitle : undefined,
            ].filter((x): x is string => Boolean(x));
            const chips = [...(d.genres ?? []).slice(0, 3), ...(d.tags ?? []).slice(0, 2)];
            const charLabel = formatCharCount(d.totalChars);
            const hasRichMeta = d.score !== undefined || d.volumeCount !== undefined || d.totalPages !== undefined || Boolean(charLabel);
            const ownedCount = ownedCountForSeries(d);

            return (
              <button key={d.url} type="button" className="k-dl-media-card" onClick={() => setUrl(d.url)}>
                <CoverThumb src={d.coverUrl} alt={d.nativeTitle ?? d.name} fallbackIcon="book" size="md" />
                <div className="k-dl-media-card__body">
                  <div className="k-dl-media-card__title">{primaryTitle}</div>
                  {subTitles.length > 0 && <div className="k-dl-media-card__subtitle">{subTitles.join(' · ')}</div>}
                  <div className="k-dl-media-card__badges">
                    {ownedCount > 0 && (
                      <span className="k-tag k-tag--tone" data-testid="mokuro-series-owned">
                        {`已入库 ${ownedCount} 卷`}
                      </span>
                    )}
                    {d.score !== undefined && <span className="k-tag k-tag--tone">★ {d.score}%</span>}
                    {d.volumeCount !== undefined && <span className="k-tag">{d.volumeCount} 卷</span>}
                    {d.totalPages !== undefined && <span className="k-tag k-tag--muted">{d.totalPages.toLocaleString()} 页</span>}
                    {charLabel && <span className="k-tag k-tag--muted">{charLabel}</span>}
                    {d.modifiedAt !== undefined && <span className="k-dl-media-card__sub">更新于 {formatDate(d.modifiedAt)}</span>}
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
          {dirs.length > visibleDirs.length && (
            <Button variant="tonal" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
              加载更多（已显示 {visibleDirs.length} / {dirs.length} 部）
            </Button>
          )}
        </div>
      )}
      {listing && !loading && dirs.length === 0 && volumes.length === 0 && <p className="k-empty">{t('downloads.noResults')}</p>}
    </section>
  );
}
