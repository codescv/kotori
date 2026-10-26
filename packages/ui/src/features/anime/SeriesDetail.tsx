/** Series detail: hero, actions (rescan · auto Jimaku · remove) and the episode list. */
import { useEffect } from 'react';
import { useRouteStore } from '../../app/routes';
import { Button } from '../../components/m3/Button';
import { Icon } from '../../components/m3/Icon';
import { IconButton } from '../../components/m3/IconButton';
import { List, ListItem } from '../../components/m3/List';
import { CircularProgress, LinearProgress } from '../../components/m3/Progress';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { formatClock } from '../../lib/cues';
import { showSnackbar } from '../../stores/snackbar';
import { useAnimeStore } from './useAnimeStore';
import './player/player.css';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function SeriesDetail({ seriesId }: { readonly seriesId: string }) {
  const host = useHost();
  const t = useT();
  const openAnime = useRouteStore((s) => s.openAnime);
  const series = useAnimeStore((s) => s.series?.find((x) => x.id === seriesId));
  const episodes = useAnimeStore((s) => s.episodes[seriesId]);
  const loadEpisodes = useAnimeStore((s) => s.loadEpisodes);
  useEffect(() => {
    void loadEpisodes(host, seriesId);
  }, [host, seriesId, loadEpisodes]);

  return (
    <div className="k-page">
      <header className="k-page__header">
        <IconButton icon="back" label={t('common.back')} onClick={() => openAnime({ kind: 'library' })} />
      </header>
      {series && (
        <section className="k-series-hero">
          {series.coverUrl && <img className="k-series-hero__cover" src={series.coverUrl} alt="" />}
          <div className="k-series-hero__text">
            <h1 className="k-headline-small" lang="ja">
              {series.title}
            </h1>
            <span className="k-body-small k-muted">{series.sourcePath}</span>
            <div className="k-row">
              <Button variant="tonal" icon="refresh" onClick={() => void host.anime.rescanSeries(seriesId).catch((e: unknown) => showSnackbar(errMsg(e), { tone: 'error' }))}>
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
              <Button
                variant="text"
                icon="delete"
                onClick={() =>
                  void host.anime
                    .removeSeries(seriesId)
                    .then(() => openAnime({ kind: 'library' }))
                    .catch((e: unknown) => showSnackbar(errMsg(e), { tone: 'error' }))
                }
              >
                {t('anime.series.remove')}
              </Button>
            </div>
          </div>
        </section>
      )}
      {!episodes && (
        <div className="k-empty">
          <CircularProgress />
        </div>
      )}
      <List>
        {episodes?.map((ep) => {
          const textTracks = ep.subtitleTracks.filter((s) => s.origin !== 'embedded' || s.filePath).length;
          const pct = ep.progress && ep.progress.durationMs > 0 ? ep.progress.positionMs / ep.progress.durationMs : undefined;
          return (
            <ListItem
              key={ep.id}
              onClick={() => openAnime({ kind: 'player', seriesId, episodeId: ep.id })}
              leading={<span className="k-title-medium">{ep.parsedName.episode ?? '–'}</span>}
              headline={<span lang="ja">{ep.title}</span>}
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
