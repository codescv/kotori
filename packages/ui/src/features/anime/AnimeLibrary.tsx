/** Anime library: continue-watching card + Fushi-style series grid (cover, synopsis, score, metadata) + import. */
import { useEffect, useState } from 'react';
import type { AnimeSeries } from '@kotori/core';
import { useRouteStore } from '../../app/routes';
import { CompactBrandButton } from '../../components/AssistantAvatar';
import { Button } from '../../components/m3/Button';
import { FilledCard, OutlinedCard } from '../../components/m3/Card';
import { CircularProgress } from '../../components/m3/Progress';
import { useT } from '../../i18n';
import { fetchAniListByIds, fetchAniListBySearch, type AniListMediaInfo } from '../downloads/anilist';
import { ImportSeriesDialog } from './ImportSeriesDialog';
import { useAnimeStore } from './useAnimeStore';
import './player/player.css';

function useSeriesMetadata(seriesList: readonly AnimeSeries[] | undefined): Readonly<Record<string, AniListMediaInfo>> {
  const [metaBySeriesId, setMetaBySeriesId] = useState<Readonly<Record<string, AniListMediaInfo>>>({});

  useEffect(() => {
    if (!seriesList || seriesList.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, AniListMediaInfo> = {};
      const withIds = seriesList.filter((s) => s.anilistId !== undefined);
      if (withIds.length > 0) {
        const byId = await fetchAniListByIds(withIds.map((s) => s.anilistId!));
        for (const s of withIds) {
          const hit = s.anilistId !== undefined ? byId.get(s.anilistId) : undefined;
          if (hit) next[s.id] = hit;
        }
      }
      await Promise.all(
        seriesList.map(async (s) => {
          if (next[s.id]) return;
          const hit = await fetchAniListBySearch(s.title);
          if (hit && hit.id < 900000) next[s.id] = hit;
        }),
      );
      if (!cancelled && Object.keys(next).length > 0) {
        setMetaBySeriesId((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seriesList]);

  return metaBySeriesId;
}

function SeriesCard({
  series,
  meta,
  onOpen,
}: {
  readonly series: AnimeSeries;
  readonly meta?: AniListMediaInfo | undefined;
  readonly onOpen: () => void;
}) {
  const t = useT();
  const coverUrl = series.coverUrl ?? meta?.coverUrl;
  const subTitle = [meta?.chineseTitle, meta?.nativeTitle, meta?.romajiTitle]
    .filter((x, i, a): x is string => Boolean(x) && x !== series.title && a.indexOf(x) === i)
    .slice(0, 2)
    .join(' · ');
  const studio = meta?.studios?.[0];

  return (
    <OutlinedCard className="k-series-card" onClick={onOpen} data-testid={`series-${series.id}`}>
      <div className="k-series-card__cover-wrap">
        {coverUrl ? (
          <img className="k-series-card__cover" src={coverUrl} alt="" loading="lazy" />
        ) : (
          <div className="k-series-card__cover k-series-card__cover--placeholder">🎬</div>
        )}
        {meta?.score !== undefined && <span className="k-tag k-tag--tone k-series-card__score">★ {meta.score}%</span>}
      </div>
      <div className="k-series-card__body">
        <span className="k-series-card__title" lang="ja" title={series.title}>
          {series.title}
        </span>
        {subTitle && (
          <span className="k-series-card__subtitle k-muted" title={subTitle}>
            {subTitle}
          </span>
        )}
        <div className="k-series-card__badges">
          <span className="k-tag">{t('anime.library.episodes', { count: series.episodeCount })}</span>
          {meta?.seasonYear && <span className="k-tag k-tag--muted">{meta.seasonYear}</span>}
          {studio && <span className="k-tag k-tag--muted">{studio}</span>}
        </div>
        {meta?.description && <p className="k-series-card__desc k-muted">{meta.description}</p>}
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
  const metaMap = useSeriesMetadata(series);
  const recent = series?.find((s) => s.lastWatchedEpisodeId);
  const recentCover = recent ? (recent.coverUrl ?? metaMap[recent.id]?.coverUrl) : undefined;

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
          {recentCover && <img className="k-continue__cover" src={recentCover} alt="" />}
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
          <SeriesCard key={s.id} series={s} meta={metaMap[s.id]} onOpen={() => openAnime({ kind: 'series', seriesId: s.id })} />
        ))}
      </div>
      <ImportSeriesDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
