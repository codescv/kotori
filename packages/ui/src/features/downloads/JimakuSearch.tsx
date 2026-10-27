/**
 * Jimaku subtitle search: entries (enriched with AniList cover art & metadata)
 * → files → download. A missing API key surfaces a call-to-action that jumps
 * to the settings page.
 */
import { useEffect, useMemo, useState } from 'react';
import { compareNatural, type JimakuEntry, type JimakuFile } from '@kotori/core';
import { Button } from '../../components/m3/Button';
import { Chip } from '../../components/m3/Chip';
import { Icon } from '../../components/m3/Icon';
import { List, ListItem } from '../../components/m3/List';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { useRouteStore } from '../../app/routes';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { fetchAniListByIds, type AniListMediaInfo } from './anilist';
import { CoverThumb } from './CoverThumb';
import { formatBytes, formatDate } from './format';
import { useDownloadsStore } from './useDownloadsStore';

type EntrySort = 'default' | 'score' | 'latest' | 'name';
type FileSort = 'episode' | 'latest' | 'size' | 'name';
type FileExtFilter = 'all' | 'ass' | 'srt';

export function JimakuSearch() {
  const host = useHost();
  const t = useT();
  const upsert = useDownloadsStore((s) => s.upsert);
  const setTab = useRouteStore((s) => s.setTab);
  const hasKey = useSettingsStore((s) => s.settings.anime.jimakuApiKey.trim().length > 0);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<readonly JimakuEntry[] | undefined>();
  const [entrySort, setEntrySort] = useState<EntrySort>('default');
  const [aniMap, setAniMap] = useState<ReadonlyMap<number, AniListMediaInfo>>(new Map());
  const [entry, setEntry] = useState<JimakuEntry | undefined>();
  const [files, setFiles] = useState<readonly JimakuFile[] | undefined>();
  const [fileSort, setFileSort] = useState<FileSort>('episode');
  const [fileExtFilter, setFileExtFilter] = useState<FileExtFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; auth: boolean } | undefined>();

  const sortedEntries = useMemo(() => {
    if (!entries) return undefined;
    if (entrySort === 'default') return entries;
    return [...entries].sort((a, b) => {
      if (entrySort === 'score') {
        const sa = (a.anilistId ? aniMap.get(a.anilistId)?.score : undefined) ?? -1;
        const sb = (b.anilistId ? aniMap.get(b.anilistId)?.score : undefined) ?? -1;
        return sb - sa || (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || compareNatural(a.japaneseName ?? a.name, b.japaneseName ?? b.name);
      }
      if (entrySort === 'latest') {
        return (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || compareNatural(a.japaneseName ?? a.name, b.japaneseName ?? b.name);
      }
      return compareNatural(a.japaneseName ?? a.name, b.japaneseName ?? b.name);
    });
  }, [entries, entrySort, aniMap]);

  const sortedFiles = useMemo(() => {
    if (!files) return undefined;
    const filtered =
      fileExtFilter === 'all'
        ? files
        : files.filter((f) => (f.extension ?? '').toLowerCase() === fileExtFilter);
    return [...filtered].sort((a, b) => {
      if (fileSort === 'latest') {
        return (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || compareNatural(a.name, b.name);
      }
      if (fileSort === 'size') {
        return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || compareNatural(a.name, b.name);
      }
      if (fileSort === 'name') {
        return compareNatural(a.name, b.name);
      }
      const ea = a.episode ?? Number.POSITIVE_INFINITY;
      const eb = b.episode ?? Number.POSITIVE_INFINITY;
      return ea - eb || compareNatural(a.name, b.name);
    });
  }, [files, fileSort, fileExtFilter]);

  useEffect(() => {
    if (!entries || entries.length === 0) return;
    let alive = true;
    const ids = entries.map((e) => e.anilistId).filter((id): id is number => id !== undefined);
    if (ids.length === 0) return;
    void fetchAniListByIds(ids).then((map) => {
      if (alive && map.size > 0) setAniMap(map);
    });
    return () => {
      alive = false;
    };
  }, [entries]);

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setLoading(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      setError({ message: e instanceof Error ? e.message : String(e), auth: code === 'ai-auth' });
      return undefined;
    } finally {
      setLoading(false);
    };
  };

  const search = async (): Promise<void> => {
    setEntry(undefined);
    setFiles(undefined);
    const r = await run(() => host.downloads.searchJimaku({ query: query.trim() }));
    if (r) setEntries(r);
  };

  const openEntry = async (e: JimakuEntry): Promise<void> => {
    setEntry(e);
    const r = await run(() => host.downloads.listJimakuFiles(e.id));
    if (r) setFiles(r);
  };

  const download = async (file: JimakuFile): Promise<void> => {
    if (!entry) return;
    try {
      const task = await host.downloads.start({ source: { kind: 'jimaku', entry, file }, title: file.name, autoImport: true });
      upsert(task);
      showSnackbar(t('downloads.nyaa.started', { title: file.name }));
    } catch (err) {
      showSnackbar(t('common.error', { message: err instanceof Error ? err.message : String(err) }), { tone: 'error' });
    }
  };

  const keyCta = (
    <div className="k-dl-cta" role="alert">
      <Icon name="key" />
      <span>{t('downloads.jimaku.noKey')}</span>
      <Button variant="tonal" onClick={() => setTab('settings')}>
        {t('downloads.jimaku.goSettings')}
      </Button>
    </div>
  );

  const selectedAni = entry?.anilistId ? aniMap.get(entry.anilistId) : undefined;

  return (
    <section className="k-dl-search">
      {!hasKey && keyCta}
      <form
        className="k-dl-search__bar"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <TextField label={t('downloads.jimaku.placeholder')} value={query} onValueChange={setQuery} leadingIcon="search" type="search" />
        <Button type="submit" icon="search" disabled={loading}>
          {t('common.search')}
        </Button>
      </form>
      {loading && <LinearProgress label={t('common.loading')} />}
      {error && (error.auth ? hasKey && keyCta : <p className="k-error-text">{t('common.error', { message: error.message })}</p>)}

      {entry ? (
        <div className="k-stack">
          <div className="k-row">
            <Button variant="text" icon="back" onClick={() => setEntry(undefined)}>
              {t('common.back')}
            </Button>
            <h3 className="k-title-medium">
              {entry.japaneseName ?? entry.name} · {t('downloads.jimaku.files')}
            </h3>
          </div>
          <div className="k-dl-banner">
            <CoverThumb src={selectedAni?.coverUrl} alt={entry.japaneseName ?? entry.name} fallbackIcon="subtitles" size="lg" />
            <div className="k-dl-banner__info">
              <div className="k-dl-banner__title">{entry.japaneseName ?? entry.name}</div>
              {(entry.englishName || entry.name !== (entry.japaneseName ?? entry.name)) && (
                <div className="k-dl-media-card__subtitle">
                  {[entry.name !== (entry.japaneseName ?? entry.name) ? entry.name : undefined, entry.englishName].filter(Boolean).join(' · ')}
                </div>
              )}
              <div className="k-dl-media-card__badges">
                {selectedAni?.score !== undefined && <span className="k-tag k-tag--tone">★ {selectedAni.score}%</span>}
                {selectedAni?.format && <span className="k-tag">{selectedAni.format}</span>}
                {selectedAni?.seasonYear && <span className="k-tag k-tag--muted">{selectedAni.seasonYear}</span>}
                {selectedAni?.episodes && <span className="k-tag">{selectedAni.episodes} 话</span>}
                {files && <span className="k-tag">{files.length} 个字幕文件</span>}
                {entry.anilistId && <span className="k-tag k-tag--muted">AniList #{entry.anilistId}</span>}
              </div>
            </div>
          </div>
          {files && files.length > 1 && (
            <div className="k-row k-dl-sort-bar">
              <Chip kind="filter" selected={fileExtFilter === 'ass'} onClick={() => setFileExtFilter((f) => (f === 'ass' ? 'all' : 'ass'))}>
                仅 ASS
              </Chip>
              <Chip kind="filter" selected={fileExtFilter === 'srt'} onClick={() => setFileExtFilter((f) => (f === 'srt' ? 'all' : 'srt'))}>
                仅 SRT
              </Chip>
              <span className="k-dl-sort-divider" aria-hidden="true" />
              <Chip kind="filter" selected={fileSort === 'episode'} onClick={() => setFileSort('episode')}>
                按集数
              </Chip>
              <Chip kind="filter" selected={fileSort === 'latest'} onClick={() => setFileSort('latest')}>
                最新上传
              </Chip>
              <Chip kind="filter" selected={fileSort === 'size'} onClick={() => setFileSort('size')}>
                按大小
              </Chip>
              <Chip kind="filter" selected={fileSort === 'name'} onClick={() => setFileSort('name')}>
                按名称
              </Chip>
            </div>
          )}
          {sortedFiles && sortedFiles.length === 0 && <p className="k-empty">{t('downloads.noResults')}</p>}
          <List>
            {(sortedFiles ?? []).map((f) => (
              <ListItem
                key={f.url}
                leading={<Icon name={f.isTextSubtitle ? 'subtitles' : 'folder'} />}
                headline={f.name}
                supporting={[
                  f.extension ? f.extension.toUpperCase() : '',
                  f.episode !== undefined ? t('downloads.jimaku.episode', { n: f.episode }) : f.archiveFormat ? t('downloads.jimaku.archive') : '',
                  formatBytes(f.sizeBytes),
                  formatDate(f.lastModifiedAt),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  <Button variant="tonal" icon="download" disabled={!f.isTextSubtitle && f.archiveFormat !== 'zip'} onClick={() => void download(f)}>
                    {t('downloads.nyaa.download')}
                  </Button>
                }
              />
            ))}
          </List>
        </div>
      ) : (
        <>
          {sortedEntries && sortedEntries.length === 0 && <p className="k-empty">{t('downloads.noResults')}</p>}
          {sortedEntries && sortedEntries.length > 1 && (
            <div className="k-row k-dl-sort-bar">
              <Chip kind="filter" selected={entrySort === 'default'} onClick={() => setEntrySort('default')}>
                默认排序
              </Chip>
              <Chip kind="filter" selected={entrySort === 'score'} onClick={() => setEntrySort('score')}>
                评分最高
              </Chip>
              <Chip kind="filter" selected={entrySort === 'latest'} onClick={() => setEntrySort('latest')}>
                最近更新
              </Chip>
              <Chip kind="filter" selected={entrySort === 'name'} onClick={() => setEntrySort('name')}>
                名称 A-Z
              </Chip>
              <span className="k-dl-count-badge">{sortedEntries.length} 个条目</span>
            </div>
          )}
          {sortedEntries && sortedEntries.length > 0 && (
            <div className="k-dl-media-list">
              {sortedEntries.map((e) => {
                const ani = e.anilistId ? aniMap.get(e.anilistId) : undefined;
                const primary = e.japaneseName ?? e.name;
                const secondary = [
                  e.name !== primary ? e.name : undefined,
                  e.englishName && e.englishName !== e.name && e.englishName !== primary ? e.englishName : undefined,
                ]
                  .filter((x): x is string => Boolean(x))
                  .join(' · ');
                return (
                  <button key={e.id} type="button" className="k-dl-media-card" onClick={() => void openEntry(e)}>
                    <CoverThumb src={ani?.coverUrl} alt={primary} fallbackIcon="subtitles" size="md" />
                    <div className="k-dl-media-card__body">
                      <div className="k-dl-media-card__title">{primary}</div>
                      {secondary && <div className="k-dl-media-card__subtitle">{secondary}</div>}
                      <div className="k-dl-media-card__badges">
                        {ani?.score !== undefined && <span className="k-tag k-tag--tone">★ {ani.score}%</span>}
                        {ani?.format && <span className="k-tag">{ani.format}</span>}
                        {ani?.seasonYear && <span className="k-tag k-tag--muted">{ani.seasonYear}</span>}
                        {ani?.episodes && <span className="k-tag">{ani.episodes} 话</span>}
                        {e.flags.movie && <span className="k-tag">Movie</span>}
                        {e.anilistId && <span className="k-tag k-tag--muted">AniList #{e.anilistId}</span>}
                        {e.flags.unverified && <span className="k-tag k-tag--muted">unverified</span>}
                        {e.lastModifiedAt && <span className="k-dl-media-card__sub">更新于 {formatDate(e.lastModifiedAt)}</span>}
                      </div>
                      {ani?.genres && ani.genres.length > 0 && (
                        <div className="k-dl-media-card__chips">
                          {ani.genres.slice(0, 4).map((g) => (
                            <span key={g} className="k-dl-chip">
                              {g}
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
        </>
      )}
    </section>
  );
}
