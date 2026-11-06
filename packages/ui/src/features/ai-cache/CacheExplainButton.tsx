/**
 * 「缓存AI解读」 button for one target (episode / volume): idle label,
 * live `缓存中 42/180 (取消)` progress while running (click = cancel, already
 * cached lines are kept), `已缓存 180/180 ✓` when complete (click = re-check /
 * resume). Clicks never bubble, so it can sit on a clickable list row or card.
 */
import type { KeyboardEvent, MouseEvent } from 'react';
import { cx } from '../../components/m3/cx';
import { Icon } from '../../components/m3/Icon';
import { CircularProgress, LinearProgress } from '../../components/m3/Progress';
import { useHost } from '../../host/HostContext';
import { useT, type Translate } from '../../i18n';
import { aiCacheKey, isActivePhase, jobDone, jobProgress, useAiCacheJob, useAiCacheStore, type AiCacheJob, type AiCacheTarget } from './useAiCacheStore';
import './ai-cache.css';

export interface KnownCacheProgress {
  readonly done: number;
  readonly total: number;
}

/** Human label for a job state (or the idle state). */
export function aiCacheLabel(job: AiCacheJob | undefined, t: Translate, known?: KnownCacheProgress): string {
  if (!job || (job.phase === 'cancelled' && job.totalItems === 0) || job.phase === 'error') {
    if (job?.phase === 'error') return t('aiCache.error');
    if (known && known.total > 0 && known.done >= known.total) return t('aiCache.done', { done: known.done, total: known.total });
    return t('aiCache.action');
  }
  switch (job.phase) {
    case 'queued':
      return t('aiCache.queued');
    case 'checking':
      return t('aiCache.checking');
    case 'ocr':
      return t('aiCache.ocr', { done: job.ocrDone, total: job.ocrTotal });
    case 'explaining':
      return t('aiCache.running', { done: jobDone(job), total: job.totalItems });
    case 'cancelled':
      return t('aiCache.cancelled', { done: jobDone(job), total: job.totalItems });
    default:
      return job.failedItems > 0
        ? t('aiCache.doneFailed', { done: jobDone(job), total: job.totalItems, failed: job.failedItems })
        : t('aiCache.done', { done: jobDone(job), total: job.totalItems });
  }
}

export interface CacheExplainButtonProps {
  readonly target: AiCacheTarget;
  /** `full` (player header), `compact` (episode rows / volume cards), `icon` (reader toolbars / HUD). */
  readonly variant?: 'full' | 'compact' | 'icon';
  readonly 'data-testid'?: string;
  /** Idle-state knowledge from the caller (e.g. the transcript's cache probe) to show `已缓存 N/N`. */
  readonly known?: KnownCacheProgress | undefined;
  readonly className?: string | undefined;
}

export function CacheExplainButton({ target, variant = 'full', known, className, 'data-testid': testId }: CacheExplainButtonProps) {
  const host = useHost();
  const t = useT();
  const key = aiCacheKey(target);
  const job = useAiCacheJob(key);
  const toggle = useAiCacheStore((s) => s.toggle);
  const active = isActivePhase(job?.phase);
  const complete = (job?.phase === 'done' && job.failedItems === 0) || (!job && known !== undefined && known.total > 0 && known.done >= known.total);
  const label = aiCacheLabel(job, t, known);
  const progress = job ? jobProgress(job) : undefined;

  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    toggle(host, target);
  };
  // Keep Enter / Space on the button from reaching a keyboard-activated parent card.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  };

  if (variant === 'icon') {
    const title = active ? `${label}` : `${t('aiCache.action')} — ${t('aiCache.tooltip')}`;
    return (
      <button
        type="button"
        className={cx('k-icon-btn k-icon-btn--standard k-ai-cache-icon', active && 'is-active', complete && 'is-complete', className)}
        aria-label={active ? `${t('aiCache.cancel')} · ${label}` : label}
        title={title}
        aria-pressed={active}
        data-testid={testId}
        data-phase={job?.phase ?? 'idle'}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {active ? <CircularProgress size={24} value={progress} label={label} /> : <Icon name={complete ? 'check' : 'cacheAi'} size={24} />}
        {active && progress !== undefined && <span className="k-ai-cache-icon__pct">{Math.round(progress * 100)}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={cx('k-ai-cache-btn', `k-ai-cache-btn--${variant}`, active && 'is-active', complete && 'is-complete', job?.phase === 'error' && 'is-error', className)}
      title={active ? t('aiCache.cancel') : t('aiCache.tooltip')}
      aria-label={active ? `${t('aiCache.cancel')} · ${label}` : label}
      aria-busy={active}
      data-testid={testId}
      data-phase={job?.phase ?? 'idle'}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className="k-ai-cache-btn__row">
        {active ? <CircularProgress size={16} value={progress} /> : <Icon name={complete ? 'check' : 'cacheAi'} size={16} />}
        <span className="k-ai-cache-btn__label">{label}</span>
      </span>
      {active && <LinearProgress className="k-ai-cache-btn__bar" value={progress} label={label} />}
    </button>
  );
}
