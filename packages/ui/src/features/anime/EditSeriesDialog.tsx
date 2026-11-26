/** Dialog for editing series title, cover URL, and AniList association (with search & unlink). */
import { useEffect, useState } from 'react';
import type { AnimeSeries, AnimeSeriesUpdatePatch } from '@kotori/core';
import { Button } from '../../components/m3/Button';
import { cx } from '../../components/m3/cx';
import { Dialog } from '../../components/m3/Dialog';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useLocale, useT } from '../../i18n';
import { isRawMediaFileName } from '../../lib/cues';
import { showSnackbar } from '../../stores/snackbar';
import { FALLBACK_ANIME_CATALOG, searchAniListMediaList, type AniListMediaInfo } from '../downloads/anilist';
import { useAnimeStore } from './useAnimeStore';

export interface EditSeriesDialogProps {
  readonly open: boolean;
  readonly series: AnimeSeries;
  readonly onClose: () => void;
}

export function EditSeriesDialog({ open, series, onClose }: EditSeriesDialogProps) {
  const host = useHost();
  const t = useT();
  const locale = useLocale();
  const [editTitle, setEditTitle] = useState(series.title);
  const [editCoverUrl, setEditCoverUrl] = useState(series.coverUrl ?? '');
  const [draftAnilistId, setDraftAnilistId] = useState<number | null | undefined>(series.anilistId);
  const [searchQuery, setSearchQuery] = useState(series.title);
  const [candidates, setCandidates] = useState<readonly AniListMediaInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setEditTitle(series.title);
    setEditCoverUrl(series.coverUrl ?? '');
    setDraftAnilistId(series.anilistId);
    setSearchQuery(series.title);
    setError(undefined);

    let cancelled = false;
    setSearching(true);
    void searchAniListMediaList(series.title, 5)
      .then((list) => {
        if (cancelled) return;
        const real = list.filter((c) => c.id < 900000);
        setCandidates(real.length > 0 ? real : FALLBACK_ANIME_CATALOG.slice(0, 4));
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, series.id, series.title, series.coverUrl, series.anilistId]);

  const runSearch = async (): Promise<void> => {
    const q = searchQuery.trim();
    if (!q) {
      setCandidates(FALLBACK_ANIME_CATALOG.slice(0, 6));
      return;
    }
    setSearching(true);
    try {
      const list = await searchAniListMediaList(q, 6);
      setCandidates(list.filter((c) => c.id < 900000));
    } finally {
      setSearching(false);
    }
  };

  const handleUnlink = (): void => {
    setDraftAnilistId(null);
    setEditCoverUrl('');
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const nextTitle = editTitle.trim();
      const trimmedCover = editCoverUrl.trim();
      const coverPatch: Pick<AnimeSeriesUpdatePatch, 'coverUrl'> =
        trimmedCover === ''
          ? draftAnilistId === null || Boolean(series.coverUrl)
            ? { coverUrl: null }
            : {}
          : trimmedCover !== series.coverUrl
            ? { coverUrl: trimmedCover }
            : {};

      const patch: AnimeSeriesUpdatePatch = {
        ...(nextTitle ? { title: nextTitle } : {}),
        ...(draftAnilistId !== undefined ? { anilistId: draftAnilistId } : {}),
        ...coverPatch,
      };
      await host.anime.updateSeries(series.id, patch);
      await useAnimeStore.getState().invalidate(host);
      showSnackbar(t('anime.edit.updated'));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('anime.edit.title')}
      icon="edit"
      wide
      data-testid="edit-series-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!editTitle.trim() || saving} onClick={() => void handleSave()} data-testid="edit-series-save-btn">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('anime.edit.nameLabel')}
        value={editTitle}
        onValueChange={setEditTitle}
        data-testid="edit-series-title-input"
      />
      <TextField
        label={t('anime.edit.coverLabel')}
        value={editCoverUrl}
        onValueChange={setEditCoverUrl}
        data-testid="edit-series-cover-input"
      />

      <div className="k-edit-series__link-bar">
        <span className="k-body-small k-muted">
          {typeof draftAnilistId === 'number'
            ? t('anime.edit.linkedAnilist', { id: draftAnilistId })
            : t('anime.edit.unlinkedAnilist')}
        </span>
        <Button variant="outlined" onClick={handleUnlink} data-testid="edit-series-unlink-btn">
          {t('anime.edit.unlinkBtn')}
        </Button>
      </div>

      <div className="k-edit-series__search-row">
        <TextField
          label={t('anime.edit.searchLabel')}
          value={searchQuery}
          onValueChange={setSearchQuery}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void runSearch();
            }
          }}
          className="k-edit-series__search-field"
          data-testid="edit-series-search-input"
        />
        <Button variant="tonal" icon="search" onClick={() => void runSearch()} data-testid="edit-series-search-btn">
          {t('common.search')}
        </Button>
      </div>

      {(searching || saving) && <LinearProgress />}

      <div className="k-anilist-candidates" role="listbox" aria-label={t('anime.edit.candidatesAria')}>
        {candidates.length === 0 && !searching && (
          <p className="k-body-small k-muted">{t('anime.edit.noMatch')}</p>
        )}
        {candidates.map((c) => {
          const primaryTitle = c.nativeTitle ?? (locale === 'zh-CN' ? c.chineseTitle : c.englishTitle) ?? c.romajiTitle ?? `#${c.id}`;
          const sub = [locale === 'zh-CN' ? c.chineseTitle : undefined, c.romajiTitle, c.englishTitle, c.seasonYear ? String(c.seasonYear) : undefined]
            .filter((x, i, a): x is string => Boolean(x) && x !== primaryTitle && a.indexOf(x) === i)
            .join(' · ');
          const selected = draftAnilistId === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={cx('k-anilist-candidate', selected && 'is-selected')}
              data-testid={`edit-series-candidate-${c.id}`}
              onClick={() => {
                setDraftAnilistId(c.id);
                if (c.coverUrl) {
                  setEditCoverUrl(c.coverUrl);
                }
                if (!editTitle.trim() || isRawMediaFileName(editTitle)) {
                  setEditTitle(primaryTitle);
                }
              }}
            >
              {c.coverUrl ? (
                <img className="k-anilist-candidate__thumb" src={c.coverUrl} alt="" loading="lazy" />
              ) : (
                <div className="k-anilist-candidate__thumb k-anilist-candidate__thumb--none">🎬</div>
              )}
              <div className="k-anilist-candidate__body">
                <span className="k-title-small" lang="ja">
                  {primaryTitle}
                </span>
                {sub && <span className="k-body-small k-muted">{sub}</span>}
              </div>
              {selected && editTitle.trim() !== primaryTitle && (
                <span
                  className="k-tag k-tag--tone"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditTitle(primaryTitle);
                  }}
                >
                  {t('anime.edit.fillName')}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && <p className="k-error-text">{error}</p>}
    </Dialog>
  );
}
