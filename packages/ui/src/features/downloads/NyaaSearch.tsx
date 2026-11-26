/**
 * Fushi-inspired 2-stage Anime Discovery & Nyaa/Jimaku Resource Search:
 *  - Stage 1 (Series Discovery & Search): Browse trending anime or search AniList
 *    series cards with 5:7 cover art, studio, score, episodes, genres, and synopsis.
 *  - Stage 2 (Series Detail & Resource Acquisition): Inspect full series details,
 *    automatically query Nyaa across Romanized + Native title aliases (deduplicated
 *    by infoHash via `mergeNyaaItems` so English/Multi-sub batches like `[Judas]`
 *    and `[SubsPlease]` appear at the top alongside Japanese/Chinese BDRips),
 *    filter by Nyaa category (`1_0` All / `1_2` Multi-Sub / `1_3` Non-English / `1_4` Raw)
 *    or pack type (`Batch` vs single episode), and grab matching Jimaku Japanese
 *    subtitles in the same view.
 *  - Also supports toggling to Direct Nyaa Torrent Search (`直接搜种子`) at any time.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  mergeNyaaItems,
  sortNyaaItems,
  type JimakuEntry,
  type JimakuFile,
  type NyaaSearchQuery,
  type NyaaTorrentItem,
} from '@kotori/core';
import { Button } from '../../components/m3/Button';
import { Chip } from '../../components/m3/Chip';
import { Icon } from '../../components/m3/Icon';
import { IconButton } from '../../components/m3/IconButton';
import { LinearProgress } from '../../components/m3/Progress';
import { TabPager, useTabPager } from '../../components/m3/TabPager';
import { useTabSwipe } from '../../components/m3/Tabs';
import { useIsInactiveTabSlide } from '../../components/m3/tabSlideContext';
import { TextField } from '../../components/m3/TextField';
import { useBackInterceptor } from '../../app/routes';
import { useHost } from '../../host/HostContext';
import { useIsExpanded } from '../../hooks/useMediaQuery';
import { useLocale, useT, type Locale, type MessageKey, type Translate } from '../../i18n';
import { showSnackbar } from '../../stores/snackbar';
import {
  buildNyaaQueriesForMedia,
  FALLBACK_ANIME_CATALOG,
  fetchAniListBySearch,
  fetchAniListTrending,
  getAniListDescription,
  searchAniListMediaList,
  type AniListMediaInfo,
} from './anilist';
import { CoverThumb } from './CoverThumb';
import { extractMediaTags, formatBytes, formatDate } from './format';
import { useDownloadsStore } from './useDownloadsStore';

type Filter = NonNullable<NyaaSearchQuery['filter']>;
type Sort = NonNullable<NyaaSearchQuery['sort']>;
type Category = '1_0' | '1_2' | '1_3' | '1_4';
type PackScope = 'all' | 'batch' | 'episode';
type SearchMode = 'series' | 'direct';
type SeriesSort = 'popularity' | 'score' | 'year' | 'name';
type DetailTab = 'torrents' | 'subtitles';
/** Stage-2 detail tabs, swipeable (nested inside the Downloads + Shell swipe strips). */
const DETAIL_TAB_ORDER: readonly DetailTab[] = ['torrents', 'subtitles'];

const CATEGORY_KEYS: Readonly<Record<string, MessageKey>> = {
  '1_2': 'downloads.nyaa.catEnglish',
  '1_3': 'downloads.nyaa.catNonEnglish',
  '1_4': 'downloads.nyaa.catRaw',
};

const STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  FINISHED: 'anime.status.FINISHED',
  RELEASING: 'anime.status.RELEASING',
  NOT_YET_RELEASED: 'anime.status.NOT_YET_RELEASED',
};

function formatNyaaWorkHeadline(
  item: NyaaTorrentItem,
  t: Translate,
  locale: Locale,
  series?: AniListMediaInfo,
): string {
  const pn = item.parsedName;
  const workTitle =
    series?.nativeTitle ??
    (locale === 'zh-CN' ? series?.chineseTitle : series?.englishTitle) ??
    series?.romajiTitle ??
    (pn.title.trim() !== '' ? pn.title.trim() : item.title);
  if (pn.episodeRange) {
    return t('downloads.nyaa.headlineRange', {
      title: workTitle,
      start: pn.episodeRange[0],
      end: pn.episodeRange[1],
    });
  }
  if (pn.isBatch) {
    return t('downloads.nyaa.headlineBatch', { title: workTitle });
  }
  if (pn.episode !== undefined) {
    return t('downloads.nyaa.headlineEpisode', { title: workTitle, n: pn.episode });
  }
  return workTitle;
}

function formatNyaaResultTaskTitle(
  item: NyaaTorrentItem,
  t: Translate,
  locale: Locale,
  series?: AniListMediaInfo,
): string {
  const headline = formatNyaaWorkHeadline(item, t, locale, series);
  return headline === item.title ? item.title : `${headline} (${item.title})`;
}

export function NyaaSearch() {
  const host = useHost();
  const t = useT();
  const locale = useLocale();
  const upsert = useDownloadsStore((s) => s.upsert);
  const canTorrent = host.info.capabilities.torrent;
  const openExternal = host.files.openExternal;

  // Top-level mode & query
  const [searchMode, setSearchMode] = useState<SearchMode>('series');
  const [query, setQuery] = useState('');

  // Stage 1: Anime Series Discovery & Search state
  const [seriesList, setSeriesList] = useState<readonly AniListMediaInfo[]>(FALLBACK_ANIME_CATALOG);
  const [hasSearchedSeries, setHasSearchedSeries] = useState(false);
  const [seriesSort, setSeriesSort] = useState<SeriesSort>('popularity');
  const [seriesLoading, setSeriesLoading] = useState(false);

  // Stage 2: Selected Series Detail state
  const [selectedSeries, setSelectedSeries] = useState<AniListMediaInfo | undefined>();
  const [descExpanded, setDescExpanded] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('torrents');
  const [activeAlias, setActiveAlias] = useState<string>('__auto__');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const isExpanded = useIsExpanded();
  // Stage 2 only: swipe 视频种子 ⇄ 日语字幕; at either edge the gesture falls through
  // to the Downloads sub-tabs (and from there to the Shell tabs).
  const interactive = !useIsInactiveTabSlide();
  const detailPager = useTabPager();
  const detailSwipe = useTabSwipe<DetailTab>(DETAIL_TAB_ORDER, detailTab, setDetailTab, {
    enabled: Boolean(selectedSeries) && interactive,
    pager: detailPager,
  });

  useBackInterceptor(
    () => {
      if (selectedSeries) {
        setSelectedSeries(undefined);
        return true;
      }
      return false;
    },
    Boolean(selectedSeries),
  );

  // Nyaa Torrent search & filter state
  const [category, setCategory] = useState<Category>('1_0');
  const [packScope, setPackScope] = useState<PackScope>('all');
  const [filter, setFilter] = useState<Filter>('none');
  const [sort, setSort] = useState<Sort>('seeders');
  const [results, setResults] = useState<readonly NyaaTorrentItem[] | undefined>();
  const [directAniInfo, setDirectAniInfo] = useState<AniListMediaInfo | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());

  // Integrated Jimaku subtitles state inside Series Detail
  const [jimakuEntry, setJimakuEntry] = useState<JimakuEntry | undefined>();
  const [jimakuFiles, setJimakuFiles] = useState<readonly JimakuFile[]>([]);
  const [jimakuLoading, setJimakuLoading] = useState(false);
  const [jimakuError, setJimakuError] = useState<string | undefined>();
  const [startedSubs, setStartedSubs] = useState<ReadonlySet<string>>(new Set());

  // Load trending anime series on mount
  useEffect(() => {
    let cancelled = false;
    void fetchAniListTrending(12).then((items) => {
      if (!cancelled) setSeriesList(items);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Run Nyaa search for a series (multi-alias or single alias) or direct query. */
  const fetchTorrentsForQueries = async (
    queries: readonly string[],
    cat: Category = category,
    f: Filter = filter,
    s: Sort = sort,
  ): Promise<void> => {
    const validQueries = queries.map((q) => q.trim()).filter((q) => q.length > 0);
    if (validQueries.length === 0) return;
    setLoading(true);
    setError(undefined);
    try {
      const lists = await Promise.all(
        validQueries.map((q) =>
          host.downloads.searchNyaa({
            query: q,
            category: cat,
            filter: f,
            sort: s,
          }),
        ),
      );
      setResults(mergeNyaaItems(lists, s));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  /** Load matching Jimaku / AJATT Japanese subtitles for the selected series. */
  const loadSeriesJimaku = async (series: AniListMediaInfo): Promise<void> => {
    setJimakuLoading(true);
    setJimakuError(undefined);
    setJimakuEntry(undefined);
    setJimakuFiles([]);
    try {
      const combinedQuery = [series.romajiTitle, series.nativeTitle, series.englishTitle]
        .filter((x): x is string => Boolean(x && x.trim()))
        .join('|');
      let entries = await host.downloads.searchJimaku({
        anilistId: series.id,
        query: combinedQuery || (series.romajiTitle ?? series.nativeTitle ?? ''),
      });
      if (entries.length === 0 && series.romajiTitle) {
        entries = await host.downloads.searchJimaku({ query: series.romajiTitle });
      }
      const first = entries[0];
      if (!first) return;
      setJimakuEntry(first);
      const files = await host.downloads.listJimakuFiles(first.id);
      setJimakuFiles(files);
    } catch (e) {
      setJimakuError(e instanceof Error ? e.message : String(e));
    } finally {
      setJimakuLoading(false);
    }
  };

  /** Open Stage-2 Series Detail view and immediately search its Nyaa torrents + Jimaku subtitles. */
  const openSeriesDetail = async (series: AniListMediaInfo): Promise<void> => {
    setSelectedSeries(series);
    setDescExpanded(false);
    setDetailTab('torrents');
    setActiveAlias('__auto__');
    setKeywordFilter('');
    const queries = buildNyaaQueriesForMedia(series);
    void loadSeriesJimaku(series);
    await fetchTorrentsForQueries(
      queries.length > 0 ? queries : [series.romajiTitle ?? series.nativeTitle ?? query],
      category,
      filter,
      sort,
    );
  };

  /** Submit top search bar. */
  const handleSearchSubmit = async (): Promise<void> => {
    const q = query.trim();
    if (searchMode === 'direct') {
      setSelectedSeries(undefined);
      void fetchAniListBySearch(q).then((info) => setDirectAniInfo(info));
      await fetchTorrentsForQueries([q], category, filter, sort);
      return;
    }
    setSelectedSeries(undefined);
    setSeriesLoading(true);
    setError(undefined);
    try {
      if (!q) {
        setHasSearchedSeries(false);
        setSeriesList(await fetchAniListTrending(12));
      } else {
        setHasSearchedSeries(true);
        const found = await searchAniListMediaList(q, 14);
        setSeriesList(found);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeriesLoading(false);
    }
  };

  const activeQueriesForCurrentContext = (alias: string = activeAlias): readonly string[] => {
    if (selectedSeries) {
      if (alias === '__auto__') {
        const auto = buildNyaaQueriesForMedia(selectedSeries);
        return auto.length > 0 ? auto : [selectedSeries.romajiTitle ?? selectedSeries.nativeTitle ?? ''];
      }
      return [alias];
    }
    return [query.trim()];
  };

  const changeCategory = (cat: Category): void => {
    setCategory(cat);
    if (selectedSeries || results) {
      void fetchTorrentsForQueries(activeQueriesForCurrentContext(), cat, filter, sort);
    }
  };

  const toggleFilter = (f: Filter): void => {
    const next = filter === f ? 'none' : f;
    setFilter(next);
    if (selectedSeries || results) {
      void fetchTorrentsForQueries(activeQueriesForCurrentContext(), category, next, sort);
    }
  };

  const changeAlias = (alias: string): void => {
    setActiveAlias(alias);
    void fetchTorrentsForQueries(activeQueriesForCurrentContext(alias), category, filter, sort);
  };

  const changeSort = (s: Sort): void => {
    setSort(s);
  };

  /** Sorted Stage-1 Anime Series List. */
  const sortedSeriesList = useMemo(() => {
    const list = [...seriesList];
    if (seriesSort === 'score') {
      return list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0));
    }
    if (seriesSort === 'year') {
      return list.sort((a, b) => (b.seasonYear ?? 0) - (a.seasonYear ?? 0) || (b.score ?? 0) - (a.score ?? 0));
    }
    if (seriesSort === 'name') {
      return list.sort((a, b) =>
        (a.nativeTitle ?? a.romajiTitle ?? '').localeCompare(b.nativeTitle ?? b.romajiTitle ?? '', 'ja'),
      );
    }
    return list;
  }, [seriesList, seriesSort]);

  /** Filtered & sorted Nyaa torrent items. */
  const displayResults = useMemo(() => {
    if (!results) return undefined;
    const kw = keywordFilter.trim().toLowerCase();
    const filtered = results.filter((item) => {
      if (packScope === 'batch' && !item.parsedName.isBatch) return false;
      if (packScope === 'episode' && item.parsedName.isBatch) return false;
      if (kw && !item.title.toLowerCase().includes(kw)) return false;
      return true;
    });
    return sortNyaaItems(filtered, sort);
  }, [results, packScope, keywordFilter, sort]);

  /** Title aliases for the currently selected series. */
  const seriesAliases = useMemo(() => {
    if (!selectedSeries) return [];
    const out: { label: string; value: string }[] = [];
    const seen = new Set<string>();
    const add = (prefix: string, val: string | undefined): void => {
      const v = (val ?? '').trim();
      if (!v) return;
      const k = v.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ label: `${prefix}: ${v}`, value: v });
    };
    add(t('downloads.nyaa.aliasRomaji'), selectedSeries.romajiTitle);
    add(t('downloads.nyaa.aliasNative'), selectedSeries.nativeTitle);
    add(t('downloads.nyaa.aliasEnglish'), selectedSeries.englishTitle);
    return out;
  }, [selectedSeries, t]);

  const downloadTorrent = async (item: NyaaTorrentItem): Promise<void> => {
    try {
      const metaSource = selectedSeries ?? directAniInfo;
      const seriesMeta = metaSource
        ? {
            anilistId: metaSource.id,
            title: metaSource.nativeTitle ?? metaSource.romajiTitle ?? item.parsedName.title,
            ...(metaSource.romajiTitle ? { romajiTitle: metaSource.romajiTitle } : {}),
            ...(metaSource.nativeTitle ? { nativeTitle: metaSource.nativeTitle } : {}),
            ...(metaSource.englishTitle ? { englishTitle: metaSource.englishTitle } : {}),
            ...(metaSource.coverUrl ? { coverUrl: metaSource.coverUrl } : {}),
          }
        : undefined;
      const headline = formatNyaaResultTaskTitle(item, t, locale, metaSource);
      const task = await host.downloads.start({
        source: {
          kind: 'torrent',
          infoHash: item.infoHash,
          magnet: item.magnet,
          torrentUrl: item.torrentUrl,
          nyaa: item,
          ...(seriesMeta ? { series: seriesMeta } : {}),
        },
        title: headline,
        autoImport: true,
      });
      upsert(task);
      setStarted((s) => new Set(s).add(item.infoHash));
      showSnackbar(t('downloads.nyaa.started', { title: formatNyaaWorkHeadline(item, t, locale, metaSource) }));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };

  const downloadSubtitle = async (file: JimakuFile): Promise<void> => {
    if (!jimakuEntry) return;
    try {
      const task = await host.downloads.start({
        source: { kind: 'jimaku', entry: jimakuEntry, file },
        title: file.name,
        autoImport: true,
      });
      upsert(task);
      setStartedSubs((s) => new Set(s).add(file.url));
      showSnackbar(t('downloads.nyaa.started', { title: file.name }));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };

  const switchSearchMode = (mode: SearchMode): void => {
    setSearchMode(mode);
    if (mode === 'direct') {
      setSelectedSeries(undefined);
      const q = query.trim();
      if (q) {
        void fetchAniListBySearch(q).then((info) => setDirectAniInfo(info));
        void fetchTorrentsForQueries([q], category, filter, sort);
      }
    }
  };

  const activeCoverUrl = selectedSeries?.coverUrl ?? directAniInfo?.coverUrl;

  // On phones the Series Detail collapses the category / trust / sort rows behind
  // one "筛选与排序 ▾" chip so the first torrents are visible on the first screen.
  const collapseFilters = Boolean(selectedSeries) && !isExpanded;
  const activeFilterCount = (category !== '1_0' ? 1 : 0) + (filter !== 'none' ? 1 : 0) + (sort !== 'seeders' ? 1 : 0) + (keywordFilter.trim() ? 1 : 0);
  const packScopeChips = (
    <>
      <Chip kind="filter" selected={packScope === 'all'} onClick={() => setPackScope('all')}>
        {t('downloads.nyaa.scopeAll')}
      </Chip>
      <Chip kind="filter" selected={packScope === 'batch'} onClick={() => setPackScope('batch')}>
        {t('downloads.nyaa.scopeBatch')}
      </Chip>
      <Chip kind="filter" selected={packScope === 'episode'} onClick={() => setPackScope('episode')}>
        {t('downloads.nyaa.scopeEpisode')}
      </Chip>
    </>
  );

  /** Stage-2 视频种子: series title alias switcher. */
  const aliasBar = seriesAliases.length > 0 && (
    <div className="k-row k-dl-sort-bar">
      <Chip
        kind="filter"
        selected={activeAlias === '__auto__'}
        onClick={() => changeAlias('__auto__')}
      >
        {t('downloads.nyaa.aliasAuto')}
      </Chip>
      {seriesAliases.map((alias) => (
        <Chip
          key={alias.value}
          kind="filter"
          selected={activeAlias === alias.value}
          onClick={() => changeAlias(alias.value)}
        >
          {alias.label}
        </Chip>
      ))}
    </div>
  );

  /** Stage-2 日语字幕: Jimaku subtitle files matched to the series. */
  const renderJimakuPanel = (series: AniListMediaInfo) => (
    <div className="k-dl-media-list" data-testid="series-jimaku-panel">
      {jimakuLoading && <LinearProgress label={t('common.loading')} />}
      {jimakuError && <p className="k-error-text">{jimakuError}</p>}
      {!jimakuLoading && jimakuFiles.length === 0 && (
        <p className="k-empty">{t('downloads.nyaa.noMatchingSubs')}</p>
      )}
      {jimakuFiles.map((file) => {
        const done = startedSubs.has(file.url);
        return (
          <div key={file.url} className="k-dl-volume-card" data-testid="series-jimaku-file">
            <CoverThumb
              src={series.coverUrl}
              alt={file.name}
              fallbackIcon="subtitles"
              size="sm"
            />
            <div className="k-dl-media-card__body">
              <div className="k-dl-result__title" title={file.name}>
                {file.name}
              </div>
              <div className="k-dl-media-card__badges">
                {file.episode !== undefined && (
                  <span className="k-tag">{t('downloads.jimaku.episode', { n: file.episode })}</span>
                )}
                <span className="k-tag k-tag--muted">{file.extension.toUpperCase()}</span>
                {file.archiveFormat && <span className="k-tag k-tag--tone">{t('downloads.jimaku.archivePack')}</span>}
                <span className="k-dl-media-card__sub">{formatBytes(file.sizeBytes)}</span>
                <span className="k-dl-media-card__sub">{formatDate(file.lastModifiedAt)}</span>
              </div>
            </div>
            <div className="k-dl-media-card__actions">
              <Button
                variant={done ? 'tonal' : 'filled'}
                icon={done ? 'check' : 'download'}
                disabled={done}
                onClick={() => void downloadSubtitle(file)}
              >
                {t('downloads.nyaa.download')}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );

  /** Nyaa torrent filters & results (Stage-2 视频种子 page, or direct mode). */
  const torrentResults = (
    <>
      {collapseFilters && (
        <div className="k-row k-dl-sort-bar k-dl-filter-summary">
          {packScopeChips}
          <Chip
            kind="filter"
            selected={filtersOpen || activeFilterCount > 0}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            data-testid="nyaa-filters-toggle"
          >
            {`${t('downloads.nyaa.filtersAndSort')}${activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} ${filtersOpen ? '▴' : '▾'}`}
          </Chip>
          {displayResults && <span className="k-dl-count-badge">{t('downloads.nyaa.torrentCount', { count: displayResults.length })}</span>}
        </div>
      )}
    
      {(!collapseFilters || filtersOpen) && (
        <div className="k-row k-dl-sort-bar" data-testid="nyaa-category-row">
          <Chip kind="filter" selected={category === '1_0'} onClick={() => changeCategory('1_0')}>
            {t('downloads.nyaa.catAll')}
          </Chip>
          <Chip kind="filter" selected={category === '1_2'} onClick={() => changeCategory('1_2')}>
            {t('downloads.nyaa.catEnglish')}
          </Chip>
          <Chip kind="filter" selected={category === '1_3'} onClick={() => changeCategory('1_3')}>
            {t('downloads.nyaa.catNonEnglish')}
          </Chip>
          <Chip kind="filter" selected={category === '1_4'} onClick={() => changeCategory('1_4')}>
            {t('downloads.nyaa.catRaw')}
          </Chip>
          {!collapseFilters && (
            <>
              <span className="k-dl-sort-divider" aria-hidden="true" />
              {packScopeChips}
            </>
          )}
        </div>
      )}
    
      {(!collapseFilters || filtersOpen) && (
        <div className="k-row k-dl-sort-bar" data-testid="nyaa-sort-row">
          <Chip kind="filter" selected={filter === 'trusted-only'} onClick={() => toggleFilter('trusted-only')}>
            {t('downloads.nyaa.trustedOnly')}
          </Chip>
          <Chip kind="filter" selected={filter === 'no-remakes'} onClick={() => toggleFilter('no-remakes')}>
            {t('downloads.nyaa.noRemakes')}
          </Chip>
          <span className="k-dl-sort-divider" aria-hidden="true" />
          <Chip kind="filter" selected={sort === 'seeders'} onClick={() => changeSort('seeders')}>
            {t('downloads.nyaa.sortSeeders')}
          </Chip>
          <Chip kind="filter" selected={sort === 'date'} onClick={() => changeSort('date')}>
            {t('downloads.nyaa.sortDate')}
          </Chip>
          <Chip kind="filter" selected={sort === 'size'} onClick={() => changeSort('size')}>
            {t('downloads.nyaa.sortSize')}
          </Chip>
          <Chip kind="filter" selected={sort === 'downloads'} onClick={() => changeSort('downloads')}>
            {t('downloads.nyaa.sortDownloads')}
          </Chip>
          {!collapseFilters && displayResults && (
            <span className="k-dl-count-badge">{t('downloads.nyaa.torrentCount', { count: displayResults.length })}</span>
          )}
        </div>
      )}
    
      {selectedSeries && results && results.length > 0 && (!collapseFilters || filtersOpen || keywordFilter !== '') && (
        <TextField
          label={t('downloads.nyaa.filterInSeries')}
          value={keywordFilter}
          onValueChange={setKeywordFilter}
          leadingIcon="search"
          type="search"
        />
      )}
    
      {searchMode === 'direct' && directAniInfo && displayResults && displayResults.length > 0 && (
        <div className="k-dl-banner">
          <CoverThumb
            src={directAniInfo.coverUrl}
            alt={directAniInfo.nativeTitle ?? directAniInfo.romajiTitle ?? query}
            fallbackIcon="movie"
            size="lg"
          />
          <div className="k-dl-banner__info">
            <div className="k-dl-banner__title">
              {directAniInfo.nativeTitle ?? directAniInfo.romajiTitle ?? query}
            </div>
            {(directAniInfo.romajiTitle || directAniInfo.englishTitle) && (
              <div className="k-dl-media-card__subtitle">
                {[directAniInfo.romajiTitle, directAniInfo.englishTitle]
                  .filter((x, i, a): x is string => Boolean(x) && a.indexOf(x) === i)
                  .join(' · ')}
              </div>
            )}
            <div className="k-dl-media-card__badges">
              {directAniInfo.score !== undefined && (
                <span className="k-tag k-tag--tone">★ {directAniInfo.score}%</span>
              )}
              {directAniInfo.format && <span className="k-tag">{directAniInfo.format}</span>}
              {directAniInfo.seasonYear && (
                <span className="k-tag k-tag--muted">{directAniInfo.seasonYear}</span>
              )}
              {directAniInfo.episodes && (
                <span className="k-tag">{t('anime.episodesShort', { count: directAniInfo.episodes })}</span>
              )}
              <span className="k-tag k-tag--muted">{t('downloads.nyaa.torrentCount', { count: displayResults.length })}</span>
            </div>
          </div>
        </div>
      )}
    
      {displayResults && displayResults.length === 0 && !loading && (
        <p className="k-empty">{t('downloads.noResults')}</p>
      )}
    
      {displayResults && displayResults.length > 0 && (
        <ul className="k-dl-results" aria-label={t('downloads.tab.anime')}>
          {displayResults.map((item) => {
            const pn = item.parsedName;
            const mediaTags = extractMediaTags(item.title);
            const catKey = CATEGORY_KEYS[item.categoryId];
            const catLabel = catKey ? t(catKey) : undefined;
            return (
              <li key={item.infoHash || item.title} className="k-dl-result" data-testid="nyaa-result">
                {activeCoverUrl && (
                  <CoverThumb src={activeCoverUrl} alt={pn.title} fallbackIcon="movie" size="sm" />
                )}
                <div className="k-dl-result__main">
                  <div className="k-dl-result__title" title={item.title}>
                    {formatNyaaWorkHeadline(item, t, locale, selectedSeries ?? directAniInfo)}
                  </div>
                  <div className="k-dl-result__sub k-muted" title={item.title}>
                    {item.title}
                  </div>
                  <div className="k-dl-result__meta">
                    {pn.releaseGroup && <span className="k-tag k-tag--muted">{pn.releaseGroup}</span>}
                    {catLabel && <span className="k-tag k-tag--muted">{catLabel}</span>}
                    {pn.episode !== undefined && (
                      <span className="k-tag">{t('downloads.jimaku.episode', { n: pn.episode })}</span>
                    )}
                    {pn.episodeRange && (
                      <span className="k-tag">
                        {t('downloads.nyaa.batch')} {pn.episodeRange[0]}–{pn.episodeRange[1]}
                      </span>
                    )}
                    {pn.isBatch && !pn.episodeRange && (
                      <span className="k-tag">{t('downloads.nyaa.batch')}</span>
                    )}
                    {pn.resolution && <span className="k-tag k-tag--muted">{pn.resolution}</span>}
                    {mediaTags.map((tag) => (
                      <span key={tag} className="k-tag k-tag--muted">
                        {tag}
                      </span>
                    ))}
                    {item.trusted && <span className="k-tag k-tag--tone">✓</span>}
                    {item.remake && <span className="k-tag k-tag--muted">{t('downloads.nyaa.remake')}</span>}
                    <span className="k-dl-result__stat k-dl-result__stat--seed" title={t('downloads.nyaa.seeders')}>
                      ▲ {item.seeders}
                    </span>
                    <span className="k-dl-result__stat">▼ {item.leechers}</span>
                    {item.downloads > 0 && <span className="k-dl-result__stat">✓ {item.downloads}</span>}
                    <span className="k-dl-result__stat" title={t('downloads.nyaa.size')}>
                      {item.sizeText}
                    </span>
                    <span className="k-dl-result__stat">{formatDate(item.publishedAt)}</span>
                  </div>
                </div>
                <div className="k-dl-result__actions">
                  {canTorrent && (
                    <Button
                      variant={started.has(item.infoHash) ? 'tonal' : 'filled'}
                      icon={started.has(item.infoHash) ? 'check' : 'download'}
                      disabled={started.has(item.infoHash)}
                      onClick={() => void downloadTorrent(item)}
                    >
                      {t('downloads.nyaa.download')}
                    </Button>
                  )}
                  {openExternal && (
                    <IconButton
                      icon="openExternal"
                      variant="tonal"
                      label={t('downloads.nyaa.openMagnet')}
                      onClick={() => void openExternal(item.magnet)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <section className="k-dl-search" data-detail-tab={selectedSeries ? detailTab : undefined} {...detailSwipe}>
      {/* Top Search Bar */}
      <form
        className="k-dl-search__bar"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSearchSubmit();
        }}
      >
        <TextField
          label={t('downloads.nyaa.placeholder')}
          value={query}
          onValueChange={setQuery}
          leadingIcon="search"
          type="search"
        />
        <Button type="submit" icon="search" disabled={loading}>
          {t('common.search')}
        </Button>
      </form>

      {/* Mode Switcher Bar: 1. 番剧发现 (Fushi 2-stage) vs 2. 直接搜种子 */}
      <div className="k-row k-dl-sort-bar">
        <Chip
          kind="filter"
          selected={searchMode === 'series'}
          onClick={() => switchSearchMode('series')}
        >
          {t('downloads.nyaa.modeSeries')}
        </Chip>
        <Chip
          kind="filter"
          selected={searchMode === 'direct'}
          onClick={() => switchSearchMode('direct')}
        >
          {t('downloads.nyaa.modeDirect')}
        </Chip>

        {searchMode === 'series' && !selectedSeries && (
          <>
            <span className="k-dl-sort-divider" aria-hidden="true" />
            <Chip kind="filter" selected={seriesSort === 'popularity'} onClick={() => setSeriesSort('popularity')}>
              {t('downloads.nyaa.seriesSortPopularity')}
            </Chip>
            <Chip kind="filter" selected={seriesSort === 'score'} onClick={() => setSeriesSort('score')}>
              {t('downloads.sortScore')}
            </Chip>
            <Chip kind="filter" selected={seriesSort === 'year'} onClick={() => setSeriesSort('year')}>
              {t('downloads.nyaa.seriesSortYear')}
            </Chip>
            <Chip kind="filter" selected={seriesSort === 'name'} onClick={() => setSeriesSort('name')}>
              {t('downloads.sortNameAZ')}
            </Chip>
            <span className="k-dl-count-badge">
              {hasSearchedSeries
                ? t('downloads.nyaa.seriesMatchedCount', { count: sortedSeriesList.length })
                : t('downloads.nyaa.seriesTrendingCount', { count: sortedSeriesList.length })}
            </span>
          </>
        )}
      </div>

      {(loading || seriesLoading) && <LinearProgress label={t('common.loading')} />}
      {error && <p className="k-error-text">{t('common.error', { message: error })}</p>}

      {/* =====================================================================
          STAGE 1: ANIME SERIES LIST (Trending or Search Matches)
          ===================================================================== */}
      {searchMode === 'series' && !selectedSeries && (
        <div className="k-dl-media-list" aria-label={t('downloads.nyaa.seriesListAria')}>
          {sortedSeriesList.map((series) => {
            const primaryTitle = series.nativeTitle ?? series.romajiTitle ?? series.englishTitle ?? t('downloads.nyaa.unknownTitle');
            const subTitles = [locale === 'zh-CN' ? series.chineseTitle : undefined, series.romajiTitle, series.englishTitle]
              .filter((x, i, a): x is string => Boolean(x) && x !== primaryTitle && a.indexOf(x) === i)
              .join(' · ');
            const studio = series.studios?.[0];
            const statusKey = series.status ? STATUS_KEYS[series.status] : undefined;
            const statusText = statusKey ? t(statusKey) : series.status;
            const seriesDesc = getAniListDescription(series, locale);
            return (
              <button
                key={series.id}
                type="button"
                className="k-dl-media-card"
                data-testid="anime-series-card"
                onClick={() => void openSeriesDetail(series)}
              >
                <CoverThumb src={series.coverUrl} alt={primaryTitle} fallbackIcon="movie" size="md" />
                <div className="k-dl-media-card__body">
                  <div className="k-dl-media-card__title">{primaryTitle}</div>
                  {subTitles && <div className="k-dl-media-card__subtitle">{subTitles}</div>}
                  <div className="k-dl-media-card__badges">
                    {series.score !== undefined && <span className="k-tag k-tag--tone">★ {series.score}%</span>}
                    {series.format && <span className="k-tag">{series.format}</span>}
                    {series.seasonYear && <span className="k-tag k-tag--muted">{series.seasonYear}</span>}
                    {series.episodes !== undefined && (
                      <span className="k-tag">{t('anime.episodesShort', { count: series.episodes })}</span>
                    )}
                    {studio && <span className="k-tag k-tag--muted">{studio}</span>}
                    {statusText && <span className="k-tag k-tag--muted">{statusText}</span>}
                  </div>
                  {seriesDesc && <p className="k-dl-media-card__desc">{seriesDesc}</p>}
                  {series.genres && series.genres.length > 0 && (
                    <div className="k-dl-media-card__chips">
                      {series.genres.slice(0, 5).map((g) => (
                        <span key={g} className="k-dl-chip">
                          {g}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="k-dl-media-card__chevron">
                  <Icon name="chevronRight" />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* =====================================================================
          STAGE 2: SERIES DETAIL + INTEGRATED NYAA TORRENTS & JIMAKU SUBTITLES
          ===================================================================== */}
      {selectedSeries && (() => {
        const selectedDesc = getAniListDescription(selectedSeries, locale);
        const selectedStatusKey = selectedSeries.status ? STATUS_KEYS[selectedSeries.status] : undefined;
        return (
        <>
          <div className="k-dl-detail-nav">
            <Button
              variant="text"
              icon="back"
              data-testid="back-to-series-list"
              onClick={() => setSelectedSeries(undefined)}
            >
              {t('downloads.nyaa.backToSeries')}
            </Button>
            <div className="k-row k-dl-sort-bar">
              <Chip
                kind="filter"
                selected={detailTab === 'torrents'}
                onClick={() => setDetailTab('torrents')}
              >
                {t('downloads.nyaa.tabTorrents', { count: displayResults?.length ?? 0 })}
              </Chip>
              <Chip
                kind="filter"
                selected={detailTab === 'subtitles'}
                onClick={() => setDetailTab('subtitles')}
              >
                {t('downloads.nyaa.tabSubtitles', { count: jimakuFiles.length })}
              </Chip>
            </div>
          </div>

          {/* Series Detail Hero Card */}
          <div className="k-dl-banner" data-testid="series-detail-banner">
            <CoverThumb
              src={selectedSeries.coverUrl}
              alt={selectedSeries.nativeTitle ?? selectedSeries.romajiTitle ?? ''}
              fallbackIcon="movie"
              size="lg"
            />
            <div className="k-dl-banner__info">
              <div className="k-dl-banner__title">
                {selectedSeries.nativeTitle ?? selectedSeries.romajiTitle ?? selectedSeries.englishTitle}
              </div>
              {((locale === 'zh-CN' && selectedSeries.chineseTitle) || selectedSeries.romajiTitle || selectedSeries.englishTitle) && (
                <div className="k-dl-media-card__subtitle">
                  {[locale === 'zh-CN' ? selectedSeries.chineseTitle : undefined, selectedSeries.romajiTitle, selectedSeries.englishTitle]
                    .filter((x, i, a): x is string => Boolean(x) && a.indexOf(x) === i)
                    .join(' · ')}
                </div>
              )}
              <div className="k-dl-media-card__badges">
                {selectedSeries.score !== undefined && (
                  <span className="k-tag k-tag--tone">★ {selectedSeries.score}%</span>
                )}
                {selectedSeries.format && <span className="k-tag">{selectedSeries.format}</span>}
                {selectedSeries.seasonYear && <span className="k-tag k-tag--muted">{selectedSeries.seasonYear}</span>}
                {selectedSeries.episodes !== undefined && (
                  <span className="k-tag">{t('anime.episodesShort', { count: selectedSeries.episodes })}</span>
                )}
                {selectedSeries.studios?.[0] && (
                  <span className="k-tag k-tag--muted">{selectedSeries.studios.join(' / ')}</span>
                )}
                {selectedSeries.status && (
                  <span className="k-tag k-tag--muted">
                    {selectedStatusKey ? t(selectedStatusKey) : selectedSeries.status}
                  </span>
                )}
              </div>
              {selectedSeries.genres && selectedSeries.genres.length > 0 && (
                <div className="k-dl-media-card__chips">
                  {selectedSeries.genres.map((g) => (
                    <span key={g} className="k-dl-chip">
                      {g}
                    </span>
                  ))}
                </div>
              )}
              {selectedDesc && (
                <div>
                  <p className={`k-dl-banner__desc ${descExpanded ? '' : 'k-dl-banner__desc--clamped'}`}>
                    {selectedDesc}
                  </p>
                  {selectedDesc.length > 90 && (
                    <button
                      type="button"
                      className="k-dl-crumb"
                      onClick={() => setDescExpanded((v) => !v)}
                    >
                      {descExpanded ? t('anime.descCollapse') : t('anime.descExpand')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
        );
      })()}

      {/* Stage-2 pages 视频种子 ⇄ 日语字幕: a flow-layout <TabPager>, so a drag shows both
          side by side; at either edge the gesture falls through to the Downloads sub-tabs. */}
      {selectedSeries ? (
        <TabPager<DetailTab>
          pager={detailPager}
          order={DETAIL_TAB_ORDER}
          value={detailTab}
          enabled={interactive}
          layout="flow"
          className="k-dl-search__pane k-dl-search__pane--detail"
          slideClassName="k-dl-search__detail-slide"
          data-testid="nyaa-detail-pane"
          renderPage={(page) =>
            page === 'torrents' ? (
              <>
                {aliasBar}
                {torrentResults}
              </>
            ) : (
              renderJimakuPanel(selectedSeries)
            )
          }
        />
      ) : (
        <div className="k-dl-search__pane" data-testid="nyaa-detail-pane">
          {searchMode === 'direct' && torrentResults}
        </div>
      )}
    </section>
  );
}
