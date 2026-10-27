/** Anime tab router: library → series detail → player (useRouteStore().anime). */
import { useEffect } from 'react';
import { useRouteStore } from '../../app/routes';
import { useHost } from '../../host/HostContext';
import { useHostEvent } from '../../host/useHostEvents';
import { AnimeLibrary } from './AnimeLibrary';
import { Player } from './player/Player';
import { SeriesDetail } from './SeriesDetail';
import { useAnimeStore } from './useAnimeStore';

export function AnimePage() {
  const host = useHost();
  const view = useRouteStore((s) => s.anime);
  const invalidate = useAnimeStore((s) => s.invalidate);
  useHostEvent('library-changed', (e) => {
    if (e.scope === 'anime') void invalidate(host);
  });
  useEffect(() => {
    void useAnimeStore.getState().loadSeries(host);
  }, [host]);
  if (view.kind === 'player') return <Player key={view.episodeId} seriesId={view.seriesId} episodeId={view.episodeId} />;
  if (view.kind === 'series') return <SeriesDetail seriesId={view.seriesId} />;
  return <AnimeLibrary />;
}
