/** Import an anime folder (desktop path browser or Android directory picker). */
import { useEffect, useState } from 'react';
import { useRouteStore } from '../../app/routes';
import { PathBrowser } from '../../components/PathBrowser';
import { Button } from '../../components/m3/Button';
import { cx } from '../../components/m3/cx';
import { Dialog } from '../../components/m3/Dialog';
import { LinearProgress } from '../../components/m3/Progress';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { searchAniListMediaList, type AniListMediaInfo } from '../downloads/anilist';
import { useAnimeStore } from './useAnimeStore';

export function ImportSeriesDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const host = useHost();
  const t = useT();
  const openAnime = useRouteStore((s) => s.openAnime);
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [candidates, setCandidates] = useState<readonly AniListMediaInfo[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<AniListMediaInfo | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const queryTerm = title.trim() || path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';

  useEffect(() => {
    if (!open) {
      setSelectedMedia(undefined);
      setCandidates([]);
      return;
    }
    const q = queryTerm.trim();
    if (!q) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchAniListMediaList(q, 4).then((list) => {
        if (!cancelled) {
          setCandidates(list.filter((c) => c.id < 900000));
        }
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, queryTerm]);

  const displayedCandidates =
    selectedMedia && !candidates.some((c) => c.id === selectedMedia.id) ? [selectedMedia, ...candidates] : candidates;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const series = await host.anime.importSeries({
        path,
        ...(title.trim() ? { titleOverride: title.trim() } : {}),
        ...(selectedMedia
          ? {
              anilistId: selectedMedia.id,
              ...(selectedMedia.coverUrl ? { coverUrl: selectedMedia.coverUrl } : {}),
            }
          : {}),
      });
      await useAnimeStore.getState().invalidate(host);
      onClose();
      setPath('');
      setTitle('');
      setSelectedMedia(undefined);
      setCandidates([]);
      openAnime({ kind: 'series', seriesId: series.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('anime.import.title')}
      icon="folder"
      wide
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!path || busy} onClick={() => void submit()}>
            {t('common.import')}
          </Button>
        </>
      }
    >
      <PathBrowser value={path} onChange={setPath} select="dir" />
      <TextField label={t('anime.import.titleOverride')} value={title} onValueChange={setTitle} />
      {Boolean(queryTerm.trim()) && (
        <div className="k-anilist-picker" data-testid="import-anilist-candidates">
          <div className="k-label-medium k-muted">番剧信息匹配（需确认，默认不关联）</div>
          <div className="k-anilist-candidates" role="radiogroup" aria-label="番剧信息匹配">
            <button
              type="button"
              role="radio"
              aria-checked={selectedMedia === undefined}
              className={cx('k-anilist-candidate', selectedMedia === undefined && 'is-selected')}
              data-testid="import-anilist-none"
              onClick={() => setSelectedMedia(undefined)}
            >
              <div className="k-anilist-candidate__thumb k-anilist-candidate__thumb--none">📁</div>
              <div className="k-anilist-candidate__body">
                <span className="k-title-small">不关联番剧数据库（仅使用文件夹/自定义名称）</span>
                <span className="k-body-small k-muted">适合综艺、真人节目、自录视频或非 AniList 收录作品</span>
              </div>
            </button>
            {displayedCandidates.map((c) => {
              const primaryTitle = c.nativeTitle ?? c.chineseTitle ?? c.romajiTitle ?? `#${c.id}`;
              const sub = [c.chineseTitle, c.romajiTitle, c.seasonYear ? String(c.seasonYear) : undefined]
                .filter((x, i, a): x is string => Boolean(x) && x !== primaryTitle && a.indexOf(x) === i)
                .join(' · ');
              const selected = selectedMedia?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={cx('k-anilist-candidate', selected && 'is-selected')}
                  data-testid={`import-anilist-candidate-${c.id}`}
                  onClick={() => {
                    setSelectedMedia(c);
                    if (!title.trim()) {
                      setTitle(primaryTitle);
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
                </button>
              );
            })}
          </div>
        </div>
      )}
      {busy && <LinearProgress />}
      {error && <p className="k-error-text">{error}</p>}
    </Dialog>
  );
}
