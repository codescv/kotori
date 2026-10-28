/** Series detail: Fushi-style hero with cover, synopsis & metadata, actions (edit · rescan · auto Jimaku · remove) and the episode list. */
import { useEffect, useRef, useState } from 'react';
import { useRouteStore } from '../../app/routes';
import { Button } from '../../components/m3/Button';
import { Icon } from '../../components/m3/Icon';
import { IconButton } from '../../components/m3/IconButton';
import { List, ListItem } from '../../components/m3/List';
import { CircularProgress, LinearProgress } from '../../components/m3/Progress';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { formatAnimeEpisodeTitle, formatAnimeSeriesTitle, formatClock } from '../../lib/cues';
import { showSnackbar } from '../../stores/snackbar';
import { fetchAniListByIds, fetchAniListBySearch, type AniListMediaInfo } from '../downloads/anilist';
import { EditSeriesDialog } from './EditSeriesDialog';
import { useAnimeStore } from './useAnimeStore';
import './player/player.css';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const STATUS_LABELS: Readonly<Record<string, string>> = {
  FINISHED: '已完结',
  RELEASING: '连载中',
  NOT_YET_RELEASED: '未开播',
};

export function SeriesDetail({ seriesId }: { readonly seriesId: string }) {
  const host = useHost();
  const t = useT();
  const openAnime = useRouteStore((s) => s.openAnime);
  const series = useAnimeStore((s) => s.series?.find((x) => x.id === seriesId));
  const episodes = useAnimeStore((s) => s.episodes[seriesId]);
  const loadEpisodes = useAnimeStore((s) => s.loadEpisodes);
  const [aniMeta, setAniMeta] = useState<AniListMediaInfo | undefined>();
  const [suggestedMeta, setSuggestedMeta] = useState<AniListMediaInfo | undefined>();
  const [dismissedSuggestion, setDismissedSuggestion] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const removingRef = useRef(false);

  useEffect(() => {
    removingRef.current = false;
    setDismissedSuggestion(false);
  }, [seriesId]);

  useEffect(() => {
    if (removingRef.current) return;
    void loadEpisodes(host, seriesId);
  }, [host, seriesId, loadEpisodes]);

  useEffect(() => {
    if (!series) {
      setAniMeta(undefined);
      setSuggestedMeta(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (series.anilistId !== undefined) {
        setSuggestedMeta(undefined);
        const byId = await fetchAniListByIds([series.anilistId]);
        const hit = byId.get(series.anilistId);
        if (!cancelled) {
          setAniMeta(hit);
        }
        return;
      }
      setAniMeta(undefined);
      const hit = await fetchAniListBySearch(series.title);
      if (!cancelled) {
        setSuggestedMeta(hit && hit.id < 900000 ? hit : undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [series]);

  const coverUrl = series?.coverUrl ?? aniMeta?.coverUrl;
  const displaySeriesTitle = formatAnimeSeriesTitle(series, aniMeta);
  const subTitles = series
    ? [aniMeta?.chineseTitle, aniMeta?.nativeTitle, aniMeta?.romajiTitle, aniMeta?.englishTitle]
        .filter((x, i, a): x is string => Boolean(x) && x !== displaySeriesTitle && a.indexOf(x) === i)
        .join(' · ')
    : '';
  const suggestedTitle = suggestedMeta
    ? (suggestedMeta.nativeTitle ?? suggestedMeta.chineseTitle ?? suggestedMeta.romajiTitle ?? '')
    : '';

  const confirmSuggestedAniList = async (): Promise<void> => {
    if (!series || !suggestedMeta) return;
    try {
      await host.anime.updateSeries(series.id, {
        anilistId: suggestedMeta.id,
        ...(suggestedMeta.coverUrl ? { coverUrl: suggestedMeta.coverUrl } : {}),
      });
      await useAnimeStore.getState().invalidate(host);
      showSnackbar('已关联番剧信息');
    } catch (e) {
      showSnackbar(errMsg(e), { tone: 'error' });
    }
  };

  const handleRemoveSeries = async (): Promise<void> => {
    if (removingRef.current) return;
    removingRef.current = true;
    useAnimeStore.getState().forgetSeries(seriesId);
    openAnime({ kind: 'library' });
    useRouteStore.getState().pruneAnimeSeries(seriesId);
    try {
      await host.anime.removeSeries(seriesId);
    } catch (e: unknown) {
      removingRef.current = false;
      void useAnimeStore.getState().invalidate(host);
      showSnackbar(errMsg(e), { tone: 'error' });
    }
  };

  return (
    <div className="k-page">
      <header className="k-page__header">
        <IconButton icon="back" label={t('common.back')} onClick={() => useRouteStore.getState().goBack()} />
      </header>
      {series && series.anilistId === undefined && suggestedMeta && !dismissedSuggestion && (
        <div className="k-anilist-banner" data-testid="anilist-confirm-banner">
          <span className="k-anilist-banner__text" lang="ja">
            {`检测到候选番剧信息：「${suggestedTitle}」`}
          </span>
          <div className="k-anilist-banner__actions">
            <Button variant="tonal" onClick={() => void confirmSuggestedAniList()} data-testid="anilist-confirm-accept-btn">
              确认关联
            </Button>
            <Button variant="outlined" onClick={() => setEditOpen(true)}>
              编辑信息
            </Button>
            <Button variant="text" onClick={() => setDismissedSuggestion(true)} data-testid="anilist-confirm-dismiss-btn">
              忽略
            </Button>
          </div>
        </div>
      )}
      {series && (
        <section className="k-series-hero">
          {coverUrl ? (
            <img className="k-series-hero__cover" src={coverUrl} alt="" />
          ) : (
            <div className="k-series-hero__cover k-series-card__cover--placeholder">🎬</div>
          )}
          <div className="k-series-hero__text">
            <h1 className="k-headline-small" lang="ja">
              {displaySeriesTitle}
            </h1>
            {subTitles && <div className="k-body-medium k-muted">{subTitles}</div>}
            <div className="k-series-card__badges">
              {aniMeta?.score !== undefined && <span className="k-tag k-tag--tone">★ {aniMeta.score}%</span>}
              {aniMeta?.format && <span className="k-tag">{aniMeta.format}</span>}
              {aniMeta?.seasonYear && <span className="k-tag k-tag--muted">{aniMeta.seasonYear}</span>}
              <span className="k-tag">{t('anime.library.episodes', { count: series.episodeCount })}</span>
              {aniMeta?.studios?.[0] && <span className="k-tag k-tag--muted">{aniMeta.studios.join(' / ')}</span>}
              {aniMeta?.status && (
                <span className="k-tag k-tag--muted">{STATUS_LABELS[aniMeta.status] ?? aniMeta.status}</span>
              )}
            </div>
            {aniMeta?.genres && aniMeta.genres.length > 0 && (
              <div className="k-series-card__badges">
                {aniMeta.genres.map((g) => (
                  <span key={g} className="k-tag k-tag--muted">
                    {g}
                  </span>
                ))}
              </div>
            )}
            {aniMeta?.description && (
              <div>
                <p className={`k-series-hero__desc ${descExpanded ? '' : 'k-series-hero__desc--clamped'}`}>
                  {aniMeta.description}
                </p>
                {aniMeta.description.length > 100 && (
                  <button
                    type="button"
                    className="k-series-hero__expand"
                    onClick={() => setDescExpanded((v) => !v)}
                  >
                    {descExpanded ? '收起简介' : '展开完整简介'}
                  </button>
                )}
              </div>
            )}
            <span className="k-body-small k-muted">{series.sourcePath}</span>
            <div className="k-row">
              <Button variant="tonal" icon="edit" onClick={() => setEditOpen(true)} data-testid="edit-series-btn">
                编辑信息
              </Button>
              <Button
                variant="tonal"
                icon="refresh"
                onClick={() =>
                  void host.anime
                    .rescanSeries(seriesId)
                    .then(() => useAnimeStore.getState().invalidate(host))
                    .catch((e: unknown) => showSnackbar(errMsg(e), { tone: 'error' }))
                }
              >
                {t('anime.series.rescan')}
              </Button>
              <Button
                variant="tonal"
                icon="cloud"
                onClick={() =>
                  void host.anime
                    .autoFetchJimaku(seriesId)
                    .then((tasks) => showSnackbar(t('anime.series.autoJimakuStarted', { count: tasks.length })))
                    .catch((e: unknown) => showSnackbar(errMsg(e), { tone: 'error' }))
                }
              >
                {t('anime.series.autoJimaku')}
              </Button>
              <Button variant="text" icon="delete" onClick={() => void handleRemoveSeries()} data-testid="remove-series-btn">
                {t('anime.series.remove')}
              </Button>
            </div>
          </div>
        </section>
      )}
      {series && <EditSeriesDialog open={editOpen} series={series} onClose={() => setEditOpen(false)} />}
      {!episodes && (
        <div className="k-empty">
          <CircularProgress />
        </div>
      )}
      <List>
        {episodes?.map((ep) => {
          const textTracks = ep.subtitleTracks.filter((s) => s.origin !== 'embedded' || s.filePath).length;
          const pct = ep.progress && ep.progress.durationMs > 0 ? ep.progress.positionMs / ep.progress.durationMs : undefined;
          const epTitle = formatAnimeEpisodeTitle(ep, displaySeriesTitle);
          return (
            <ListItem
              key={ep.id}
              onClick={() => openAnime({ kind: 'player', seriesId, episodeId: ep.id })}
              leading={<span className="k-title-medium">{ep.parsedName.episode ?? '–'}</span>}
              headline={
                <span lang="ja">
                  {displaySeriesTitle && !epTitle.includes(displaySeriesTitle) && (
                    <>
                      <span>{displaySeriesTitle}</span>
                      {' · '}
                    </>
                  )}
                  <span>{epTitle}</span>
                </span>
              }
              supporting={
                <>
                  {ep.fileName}
                  <br />
                  {textTracks > 0 ? t('anime.series.subs', { count: textTracks }) : t('anime.series.noSubs')}
                  {ep.durationMs ? ` · ${formatClock(ep.durationMs)}` : ''}
                  {pct !== undefined && <LinearProgress className="k-episode-progress" value={pct} label={t('anime.series.watched', { percent: Math.round(pct * 100) })} />}
                </>
              }
              trailing={<Icon name="play" />}
            />
          );
        })}
      </List>
    </div>
  );
}
