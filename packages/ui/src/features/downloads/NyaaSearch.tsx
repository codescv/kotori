/**
 * Nyaa search (RSS via the host) with filter chips and 1-click download.
 * Hosts without a torrent engine (Android) hand the magnet to an external app.
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
import { formatDate } from './format';
import { useDownloadsStore } from './useDownloadsStore';

type Filter = NonNullable<NyaaSearchQuery['filter']>;

export function NyaaSearch() {
  const host = useHost();
  const t = useT();
  const upsert = useDownloadsStore((s) => s.upsert);
  const canTorrent = host.info.capabilities.torrent;
  const openExternal = host.files.openExternal;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('none');
  const [results, setResults] = useState<readonly NyaaTorrentItem[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());

  const search = async (f: Filter = filter): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setResults(await host.downloads.searchNyaa({ query: query.trim(), filter: f, sort: 'seeders' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleFilter = (f: Filter): void => {
    const next = filter === f ? 'none' : f;
    setFilter(next);
    if (results) void search(next);
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
      <div className="k-row">
        <Chip kind="filter" selected={filter === 'trusted-only'} onClick={() => toggleFilter('trusted-only')}>
          {t('downloads.nyaa.trustedOnly')}
        </Chip>
        <Chip kind="filter" selected={filter === 'no-remakes'} onClick={() => toggleFilter('no-remakes')}>
          {t('downloads.nyaa.noRemakes')}
        </Chip>
      </div>
      {loading && <LinearProgress label={t('common.loading')} />}
      {error && <p className="k-error-text">{t('common.error', { message: error })}</p>}
      {results && results.length === 0 && !loading && <p className="k-empty">{t('downloads.noResults')}</p>}
      {results && results.length > 0 && (
        <ul className="k-dl-results" aria-label={t('downloads.tab.anime')}>
          {results.map((item) => {
            const pn = item.parsedName;
            return (
              <li key={item.infoHash} className="k-dl-result" data-testid="nyaa-result">
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
                    {item.trusted && <span className="k-tag k-tag--tone">✓</span>}
                    {item.remake && <span className="k-tag k-tag--muted">remake</span>}
                    <span className="k-dl-result__stat" title={t('downloads.nyaa.seeders')}>
                      ▲ {item.seeders}
                    </span>
                    <span className="k-dl-result__stat">▼ {item.leechers}</span>
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
