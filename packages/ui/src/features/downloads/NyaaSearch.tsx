/**
 * Nyaa search (RSS via the host) with AniList cover & metadata banner, filter/sort
 * chips, parsed technical media badges, and 1-click download.
 * Hosts without a torrent engine hand the magnet to an external app.
 */
import { useState } from 'react';
import type { NyaaSearchQuery, NyaaTorrentItem } from '@kotori/core';
import { Chip } from '../../components/m3/Chip';
import { IconButton } from '../../components/m3/IconButton';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { Button } from '../../components/m3/Button';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { showSnackbar } from '../../stores/snackbar';
import { fetchAniListBySearch, type AniListMediaInfo } from './anilist';
import { CoverThumb } from './CoverThumb';
import { extractMediaTags, formatDate } from './format';
import { useDownloadsStore } from './useDownloadsStore';

type Filter = NonNullable<NyaaSearchQuery['filter']>;
type Sort = NonNullable<NyaaSearchQuery['sort']>;

export function NyaaSearch() {
  const host = useHost();
  const t = useT();
  const upsert = useDownloadsStore((s) => s.upsert);
  const canTorrent = host.info.capabilities.torrent;
  const openExternal = host.files.openExternal;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('none');
  const [sort, setSort] = useState<Sort>('seeders');
  const [results, setResults] = useState<readonly NyaaTorrentItem[] | undefined>();
  const [aniInfo, setAniInfo] = useState<AniListMediaInfo | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());

  const search = async (f: Filter = filter, s: Sort = sort): Promise<void> => {
    const q = query.trim();
    setLoading(true);
    setError(undefined);
    void fetchAniListBySearch(q).then((info) => setAniInfo(info));
    try {
      setResults(await host.downloads.searchNyaa({ query: q, filter: f, sort: s }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleFilter = (f: Filter): void => {
    const next = filter === f ? 'none' : f;
    setFilter(next);
    if (results) void search(next, sort);
  };

  const changeSort = (s: Sort): void => {
    setSort(s);
    if (results) void search(filter, s);
  };

  const download = async (item: NyaaTorrentItem): Promise<void> => {
    try {
      const task = await host.downloads.start({
        source: { kind: 'torrent', infoHash: item.infoHash, magnet: item.magnet, torrentUrl: item.torrentUrl, nyaa: item },
        title: item.title,
        autoImport: true,
      });
      upsert(task);
      setStarted((s) => new Set(s).add(item.infoHash));
      showSnackbar(t('downloads.nyaa.started', { title: item.title }));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };

  return (
    <section className="k-dl-search">
      <form
        className="k-dl-search__bar"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <TextField label={t('downloads.nyaa.placeholder')} value={query} onValueChange={setQuery} leadingIcon="search" type="search" />
        <Button type="submit" icon="search" disabled={loading}>
          {t('common.search')}
        </Button>
      </form>
      <div className="k-row k-dl-sort-bar">
        <Chip kind="filter" selected={filter === 'trusted-only'} onClick={() => toggleFilter('trusted-only')}>
          {t('downloads.nyaa.trustedOnly')}
        </Chip>
        <Chip kind="filter" selected={filter === 'no-remakes'} onClick={() => toggleFilter('no-remakes')}>
          {t('downloads.nyaa.noRemakes')}
        </Chip>
        <span className="k-dl-sort-divider" aria-hidden="true" />
        <Chip kind="filter" selected={sort === 'seeders'} onClick={() => changeSort('seeders')}>
          按做种
        </Chip>
        <Chip kind="filter" selected={sort === 'date'} onClick={() => changeSort('date')}>
          按时间
        </Chip>
        <Chip kind="filter" selected={sort === 'size'} onClick={() => changeSort('size')}>
          按体积
        </Chip>
        <Chip kind="filter" selected={sort === 'downloads'} onClick={() => changeSort('downloads')}>
          按完成量
        </Chip>
      </div>
      {loading && <LinearProgress label={t('common.loading')} />}
      {error && <p className="k-error-text">{t('common.error', { message: error })}</p>}
      {aniInfo && results && results.length > 0 && (
        <div className="k-dl-banner">
          <CoverThumb src={aniInfo.coverUrl} alt={aniInfo.nativeTitle ?? aniInfo.romajiTitle ?? query} fallbackIcon="movie" size="lg" />
          <div className="k-dl-banner__info">
            <div className="k-dl-banner__title">{aniInfo.nativeTitle ?? aniInfo.romajiTitle ?? query}</div>
            {(aniInfo.romajiTitle || aniInfo.englishTitle) && (
              <div className="k-dl-media-card__subtitle">
                {[aniInfo.romajiTitle, aniInfo.englishTitle].filter((x, i, a): x is string => Boolean(x) && a.indexOf(x) === i).join(' · ')}
              </div>
            )}
            <div className="k-dl-media-card__badges">
              {aniInfo.score !== undefined && <span className="k-tag k-tag--tone">★ {aniInfo.score}%</span>}
              {aniInfo.format && <span className="k-tag">{aniInfo.format}</span>}
              {aniInfo.seasonYear && <span className="k-tag k-tag--muted">{aniInfo.seasonYear}</span>}
              {aniInfo.episodes && <span className="k-tag">{aniInfo.episodes} 话</span>}
              <span className="k-tag k-tag--muted">{results.length} 条种子</span>
            </div>
            {aniInfo.genres && aniInfo.genres.length > 0 && (
              <div className="k-dl-media-card__chips">
                {aniInfo.genres.slice(0, 5).map((g) => (
                  <span key={g} className="k-dl-chip">
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {results && results.length === 0 && !loading && <p className="k-empty">{t('downloads.noResults')}</p>}
      {results && results.length > 0 && (
        <ul className="k-dl-results" aria-label={t('downloads.tab.anime')}>
          {results.map((item) => {
            const pn = item.parsedName;
            const mediaTags = extractMediaTags(item.title);
            return (
              <li key={item.infoHash} className="k-dl-result" data-testid="nyaa-result">
                {aniInfo?.coverUrl && <CoverThumb src={aniInfo.coverUrl} alt={pn.title} fallbackIcon="movie" size="sm" />}
                <div className="k-dl-result__main">
                  <div className="k-dl-result__title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="k-dl-result__meta">
                    {pn.releaseGroup && <span className="k-tag k-tag--muted">{pn.releaseGroup}</span>}
                    {pn.episode !== undefined && <span className="k-tag">{t('downloads.jimaku.episode', { n: pn.episode })}</span>}
                    {pn.episodeRange && (
                      <span className="k-tag">
                        {t('downloads.nyaa.batch')} {pn.episodeRange[0]}–{pn.episodeRange[1]}
                      </span>
                    )}
                    {pn.resolution && <span className="k-tag k-tag--muted">{pn.resolution}</span>}
                    {mediaTags.map((tag) => (
                      <span key={tag} className="k-tag k-tag--muted">
                        {tag}
                      </span>
                    ))}
                    {item.trusted && <span className="k-tag k-tag--tone">✓</span>}
                    {item.remake && <span className="k-tag k-tag--muted">remake</span>}
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
                      onClick={() => void download(item)}
                    >
                      {t('downloads.nyaa.download')}
                    </Button>
                  )}
                  {openExternal && (
                    <IconButton icon="openExternal" variant="tonal" label={t('downloads.nyaa.openMagnet')} onClick={() => void openExternal(item.magnet)} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
