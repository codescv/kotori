/**
 * Background 「缓存AI解读」 progress surfaces:
 * - `AiCacheGlobalBar` (Shell): compact status bar with title, `X / Y`,
 *   progress and `×` cancel whenever a job runs for something other than the
 *   screen the user is on.
 * - `AiCacheProgressPill` (Reader): non-blocking floating pill for the open
 *   volume (mobile portrait users get progress + 1-tap cancel too).
 */
import { useRouteStore } from '../../app/routes';
import { Icon } from '../../components/m3/Icon';
import { IconButton } from '../../components/m3/IconButton';
import { LinearProgress } from '../../components/m3/Progress';
import { useT } from '../../i18n';
import { aiCacheLabel } from './CacheExplainButton';
import { isActivePhase, jobProgress, useAiCacheJob, useAiCacheStore, type AiCacheJob } from './useAiCacheStore';
import './ai-cache.css';

/** Key of the target the current screen already shows progress for (player / reader). */
function useOnScreenKey(): string | undefined {
  return useRouteStore((s) => {
    if (s.tab === 'anime' && s.anime.kind === 'player') return `anime:${s.anime.episodeId}`;
    if (s.tab === 'manga' && s.manga.kind === 'reader') return `manga:${s.manga.volumeId}`;
    return undefined;
  });
}

const EMPTY: readonly AiCacheJob[] = [];

export function AiCacheGlobalBar() {
  const t = useT();
  const onScreen = useOnScreenKey();
  const jobs = useAiCacheStore((s) => s.jobs);
  const cancel = useAiCacheStore((s) => s.cancel);
  const active = Object.values(jobs).filter((j) => isActivePhase(j.phase));
  const visible = active.length > 0 && active.some((j) => j.key !== onScreen) ? active : EMPTY;
  if (visible.length === 0) return null;
  // The running job first, then queued ones.
  const current = visible.find((j) => j.phase !== 'queued') ?? visible[0]!;
  const queued = visible.filter((j) => j.key !== current.key).length;
  const label = aiCacheLabel(current, t);
  return (
    <div className="k-ai-cache-bar" role="status" aria-live="polite" data-testid="ai-cache-global-bar">
      <div className="k-ai-cache-bar__main">
        <span className="k-ai-cache-bar__title" lang="ja" title={current.title}>
          <Icon name="cacheAi" size={16} />
          {t('aiCache.action')} · {current.title}
        </span>
        <LinearProgress value={jobProgress(current)} label={label} />
        <span className="k-ai-cache-bar__meta" data-testid="ai-cache-global-progress">
          {label}
          {queued > 0 ? ` · ${t('aiCache.queuedMore', { count: queued })}` : ''}
        </span>
      </div>
      <IconButton icon="close" size="small" label={t('aiCache.cancel')} data-testid="ai-cache-global-cancel" onClick={() => cancel(current.key)} />
    </div>
  );
}

export function AiCacheProgressPill({ jobKey, 'data-testid': testId }: { readonly jobKey: string; readonly 'data-testid'?: string }) {
  const t = useT();
  const job = useAiCacheJob(jobKey);
  const cancel = useAiCacheStore((s) => s.cancel);
  if (!job || !isActivePhase(job.phase)) return null;
  const label = aiCacheLabel(job, t);
  return (
    <div className="k-ai-cache-pill" role="status" aria-live="polite" data-testid={testId}>
      <div className="k-ai-cache-pill__text">
        <span>{label}</span>
        <LinearProgress value={jobProgress(job)} label={label} />
      </div>
      <IconButton icon="close" size="small" label={t('aiCache.cancel')} onClick={() => cancel(job.key)} />
    </div>
  );
}
