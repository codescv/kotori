/**
 * Manga library: cover grid with OCR / raw badges and reading progress.
 * Refreshes on `library-changed` (scope `manga`) host events.
 */
import { useMemo, useState } from 'react';
import type { MangaVolume } from '@kotori/core';
import { CompactBrandButton } from '../../components/AssistantAvatar';
import { Button } from '../../components/m3/Button';
import { ElevatedCard } from '../../components/m3/Card';
import { Chip } from '../../components/m3/Chip';
import { Dialog } from '../../components/m3/Dialog';
import { IconButton } from '../../components/m3/IconButton';
import { CircularProgress, LinearProgress } from '../../components/m3/Progress';
import { useHost } from '../../host/HostContext';
import { useAsync } from '../../host/useAsync';
import { useHostEvent } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { inferMangaSeriesTitle, sortVolumesInSeries } from '../../lib/manga';
import { showSnackbar } from '../../stores/snackbar';
import { ImportVolumeDialog } from './ImportVolumeDialog';

export interface MangaLibraryProps {
  readonly onOpen: (volumeId: string) => void;
}

export function MangaLibrary({ onOpen }: MangaLibraryProps) {
  const host = useHost();
  const t = useT();
  const volumes = useAsync(() => host.manga.listVolumes(), [host]);
  const [importOpen, setImportOpen] = useState(false);
  const [removing, setRemoving] = useState<MangaVolume | undefined>();
  const [selectedSeries, setSelectedSeries] = useState<string>('__all__');
  useHostEvent('library-changed', (e) => e.scope === 'manga' && volumes.reload());

  const remove = async (v: MangaVolume): Promise<void> => {
    setRemoving(undefined);
    try {
      await host.manga.removeVolume(v.id);
      volumes.reload();
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };

  const list = volumes.data ?? [];
  const seriesGroups = useMemo(() => {
    const map = new Map<string, MangaVolume[]>();
    for (const v of list) {
      const s = inferMangaSeriesTitle(v);
      const arr = map.get(s) ?? [];
      arr.push(v);
      map.set(s, arr);
    }
    for (const [k, arr] of map.entries()) {
      map.set(k, sortVolumesInSeries(arr));
    }
    return map;
  }, [list]);

  const multiVolumeSeries = useMemo(
    () => [...seriesGroups.entries()].filter(([, arr]) => arr.length > 1),
    [seriesGroups],
  );

  const displayedList = useMemo(() => {
    if (selectedSeries !== '__all__' && seriesGroups.has(selectedSeries)) {
      return seriesGroups.get(selectedSeries) ?? [];
    }
    const out: MangaVolume[] = [];
    for (const [, arr] of seriesGroups.entries()) {
      out.push(...arr);
    }
    return out;
  }, [selectedSeries, seriesGroups]);

  return (
    <div className="k-page k-manga-library">
      <header className="k-page__header">
        <CompactBrandButton />
        <h1 className="k-headline-small">{t('manga.library.title')}</h1>
        <span className="k-spacer" />
        <Button icon="add" onClick={() => setImportOpen(true)}>
          {t('manga.library.import')}
        </Button>
      </header>
      {multiVolumeSeries.length > 0 && (
        <div className="k-row k-manga-library__series-bar" data-testid="manga-series-chips">
          <Chip kind="filter" selected={selectedSeries === '__all__'} onClick={() => setSelectedSeries('__all__')}>
            {`全部 (${list.length})`}
          </Chip>
          {multiVolumeSeries.map(([seriesTitle, arr]) => (
            <Chip
              key={seriesTitle}
              kind="filter"
              selected={selectedSeries === seriesTitle}
              onClick={() => setSelectedSeries(selectedSeries === seriesTitle ? '__all__' : seriesTitle)}
            >
              {`📚 ${seriesTitle} (${arr.length} 卷)`}
            </Chip>
          ))}
        </div>
      )}
      {volumes.loading && !volumes.data && (
        <div className="k-empty">
          <CircularProgress label={t('common.loading')} />
        </div>
      )}
      {volumes.error && <p className="k-error-text">{t('common.error', { message: volumes.error.message })}</p>}
      {volumes.data && list.length === 0 && <p className="k-empty">{t('manga.library.empty')}</p>}
      <div className="k-grid-cards">
        {displayedList.map((v) => {
          const progress = v.progress && v.pageCount > 1 ? (v.progress.pageIndex + 1) / v.pageCount : undefined;
          const sTitle = inferMangaSeriesTitle(v);
          const siblings = seriesGroups.get(sTitle) ?? [v];
          const volIndex = siblings.findIndex((x) => x.id === v.id);
          return (
            <ElevatedCard key={v.id} className="k-volume-card" onClick={() => onOpen(v.id)} aria-label={v.title} data-testid={`volume-${v.id}`}>
              <div className="k-volume-card__cover">
                {v.coverUrl ? <img src={v.coverUrl} alt="" loading="lazy" /> : <div className="k-volume-card__placeholder">📖</div>}
                <span className={v.hasOcr ? 'k-tag k-volume-card__badge' : 'k-tag k-tag--muted k-volume-card__badge'}>
                  {v.hasOcr ? t('manga.library.ocr') : t('manga.library.raw')}
                </span>
              </div>
              <div className="k-volume-card__body">
                <div className="k-volume-card__title" lang="ja" title={v.title}>
                  {v.title}
                </div>
                {siblings.length > 1 && (
                  <div className="k-volume-card__series k-label-small" data-testid={`volume-series-${v.id}`}>
                    {`${sTitle} · 第 ${v.volumeNumber ?? volIndex + 1} 卷 / 共 ${siblings.length} 卷`}
                  </div>
                )}
                <div className="k-volume-card__meta k-muted">
                  {t('manga.library.pages', { count: v.pageCount })}
                  {v.progress && ` · ${t('manga.reader.page', { current: v.progress.pageIndex + 1, total: v.pageCount })}`}
                </div>
                {progress !== undefined && <LinearProgress value={progress} />}
              </div>
              <IconButton
                className="k-volume-card__remove"
                icon="delete"
                size="small"
                label={t('common.delete')}
                onClick={(e) => {
                  e.stopPropagation();
                  setRemoving(v);
                }}
              />
            </ElevatedCard>
          );
        })}
      </div>
      <ImportVolumeDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(v) => {
          setImportOpen(false);
          volumes.reload();
          showSnackbar(v.title);
        }}
      />
      <Dialog
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        title={removing?.title ?? ''}
        icon="delete"
        actions={
          <>
            <Button variant="text" onClick={() => setRemoving(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => removing && void remove(removing)}>{t('common.delete')}</Button>
          </>
        }
      >
        <p>{t('manga.library.removeConfirm')}</p>
      </Dialog>
    </div>
  );
}
