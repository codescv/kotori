/** Anime library: continue-watching card + series grid + import. */
import { useState } from 'react';
import type { AnimeSeries } from '@kotori/core';
import { useRouteStore } from '../../app/routes';
import { CompactBrandButton } from '../../components/AssistantAvatar';
import { Button } from '../../components/m3/Button';
import { FilledCard, OutlinedCard } from '../../components/m3/Card';
import { CircularProgress } from '../../components/m3/Progress';
import { useT } from '../../i18n';
import { ImportSeriesDialog } from './ImportSeriesDialog';
import { useAnimeStore } from './useAnimeStore';
import './player/player.css';

function SeriesCard({ series, onOpen }: { readonly series: AnimeSeries; readonly onOpen: () => void }) {
  const t = useT();
  return (
    <OutlinedCard className="k-series-card" onClick={onOpen} data-testid={`series-${series.id}`}>
      {series.coverUrl ? <img className="k-series-card__cover" src={series.coverUrl} alt="" loading="lazy" /> : <div className="k-series-card__cover" />}
      <div className="k-series-card__body">
        <span className="k-series-card__title" lang="ja">
          {series.title}
        </span>
        <span className="k-body-small k-muted">{t('anime.library.episodes', { count: series.episodeCount })}</span>
      </div>
    </OutlinedCard>
  );
}

export function AnimeLibrary() {
  const t = useT();
  const series = useAnimeStore((s) => s.series);
  const loading = useAnimeStore((s) => s.loading);
  const error = useAnimeStore((s) => s.error);
  const openAnime = useRouteStore((s) => s.openAnime);
  const [importOpen, setImportOpen] = useState(false);
  const recent = series?.find((s) => s.lastWatchedEpisodeId);

  return (
    <div className="k-page">
      <header className="k-page__header">
        <CompactBrandButton />
        <h1 className="k-headline-small">{t('anime.library.title')}</h1>
        <span className="k-spacer" />
        <Button icon="add" onClick={() => setImportOpen(true)}>
          {t('anime.library.import')}
        </Button>
      </header>
      {error && <p className="k-error-text">{t('common.error', { message: error })}</p>}
      {recent?.lastWatchedEpisodeId && (
        <FilledCard className="k-continue" onClick={() => openAnime({ kind: 'player', seriesId: recent.id, episodeId: recent.lastWatchedEpisodeId ?? '' })}>
          {recent.coverUrl && <img className="k-continue__cover" src={recent.coverUrl} alt="" />}
          <div className="k-continue__text">
            <span className="k-label-medium k-muted">{t('anime.library.continue')}</span>
            <span className="k-title-medium" lang="ja">
              {recent.title}
            </span>
          </div>
          <Button variant="tonal" icon="play">
            {t('player.play')}
          </Button>
        </FilledCard>
      )}
      {series === undefined && loading && (
        <div className="k-empty">
          <CircularProgress />
        </div>
      )}
      {series?.length === 0 && <p className="k-empty">{t('anime.library.empty')}</p>}
      <div className="k-grid-cards">
        {series?.map((s) => (
          <SeriesCard key={s.id} series={s} onOpen={() => openAnime({ kind: 'series', seriesId: s.id })} />
        ))}
      </div>
      <ImportSeriesDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
