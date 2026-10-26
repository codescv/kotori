/**
 * Sentence repeat: single-cue loop (`R`, `AnimeSettings.repeatCount` times,
 * 0 = ∞) and A-B loop over the rows selected in the transcript.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '../../../components/m3/cx';
import { IconButton } from '../../../components/m3/IconButton';
import type { Translate } from '../../../i18n';

export type RepeatState =
  | { readonly kind: 'cue'; readonly startMs: number; readonly endMs: number; readonly done: number; readonly total: number }
  | { readonly kind: 'ab'; readonly startMs: number; readonly endMs: number };

export interface RepeatApi {
  readonly state: RepeatState | undefined;
  startCue(startMs: number, endMs: number, total: number): void;
  startAb(startMs: number, endMs: number): void;
  stop(): void;
}

/**
 * Drives the loop from the clock: when `currentMs` passes the loop end it
 * seeks back to `startMs - paddingMs`; single-cue loops stop after `total`
 * plays (the line has then been heard `total` times).
 */
export function useRepeat(currentMs: number, seek: (ms: number) => void, paddingMs: number): RepeatApi {
  const [state, setState] = useState<RepeatState | undefined>(undefined);
  // Re-armed once the clock is back inside the loop, so one pass over the end
  // triggers exactly one seek even if the clock update lags behind the seek.
  const armed = useRef(true);
  useEffect(() => {
    if (!state) return;
    if (currentMs < state.endMs) {
      armed.current = true;
      return;
    }
    if (!armed.current) return;
    armed.current = false;
    if (state.kind === 'cue') {
      const done = state.done + 1;
      if (state.total > 0 && done >= state.total) {
        setState(undefined);
        return;
      }
      setState({ ...state, done });
    }
    seek(Math.max(0, state.startMs - paddingMs));
  }, [currentMs, state, seek, paddingMs]);
  const startCue = useCallback((startMs: number, endMs: number, total: number) => {
    armed.current = true;
    setState({ kind: 'cue', startMs, endMs, done: 0, total });
  }, []);
  const startAb = useCallback((startMs: number, endMs: number) => {
    armed.current = true;
    setState({ kind: 'ab', startMs, endMs });
  }, []);
  const stop = useCallback(() => setState(undefined), []);
  return { state, startCue, startAb, stop };
}

export interface RepeatControlsProps {
  readonly repeat: RepeatApi;
  /** Toggle single-cue repeat for the current line. */
  readonly onToggleCue: () => void;
  /** Toggle A-B over selected transcript rows (disabled when nothing is selected). */
  readonly onToggleAb: () => void;
  readonly canAb: boolean;
  readonly t: Translate;
}

export function RepeatControls({ repeat, onToggleCue, onToggleAb, canAb, t }: RepeatControlsProps) {
  const s = repeat.state;
  const cueLabel =
    s?.kind === 'cue' ? (s.total === 0 ? t('player.repeatInfinite') : t('player.repeatOn', { n: s.done + 1, total: s.total })) : t('player.repeat');
  return (
    <div className="k-repeat">
      <IconButton icon="repeatOne" label={cueLabel} selected={s?.kind === 'cue'} onClick={onToggleCue} />
      {s?.kind === 'cue' && (
        <span className={cx('k-repeat__count')} data-testid="repeat-count">
          {s.total === 0 ? '∞' : `${s.done + 1}/${s.total}`}
        </span>
      )}
      <IconButton icon="repeat" label={t('player.abLoop')} selected={s?.kind === 'ab'} disabled={!canAb && s?.kind !== 'ab'} onClick={onToggleAb} />
    </div>
  );
}
