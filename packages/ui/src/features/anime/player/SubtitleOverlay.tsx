/**
 * Subtitle overlay over the video: the cues on screen right now, rendered as
 * plain text (no libass) with every character clickable. Per-character ASS
 * karaoke events are shown once as their merged sentence when
 * `mergeKaraoke` is on. Blind-listening mode (`B`) blurs the text until hover.
 * The focused chunk of the open explanation is painted back onto the cue.
 */
import { memo, useMemo } from 'react';
import type { SubtitleCue } from '@kotori/core';
import { RubyText } from '../../../components/breakdown/RubyText';
import { cx } from '../../../components/m3/cx';
import { mergePerCharacterCueGroups } from '../../../lib/cues';
import type { CueHighlight } from './useSubtitleBreakdown';

export interface SubtitleOverlayProps {
  readonly cues: readonly SubtitleCue[];
  /** Array positions of the cues on screen. */
  readonly activeIndexes: readonly number[];
  readonly mergeKaraoke: boolean;
  readonly blind: boolean;
  readonly onCharClick: (cue: SubtitleCue, localCharIndex: number) => void;
  readonly highlightFor: (cue: SubtitleCue) => CueHighlight;
  readonly blindHint?: string;
}

/** Cues to display for the active set: karaoke groups merged, duplicates/comments/drawings dropped. */
export function visibleCues(cues: readonly SubtitleCue[], activeIndexes: readonly number[], groups: ReturnType<typeof mergePerCharacterCueGroups> | undefined): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  const seen = new Set<string>();
  for (const pos of activeIndexes) {
    const raw = cues[pos];
    if (!raw) continue;
    if (raw.markup?.isComment || raw.markup?.isDrawing || raw.text.trim() === '') continue;
    const rep = groups?.repByRaw.get(raw.index);
    const cue = rep !== undefined ? (groups?.byRep.get(rep) ?? raw) : raw;
    const key = `${cue.startMs}\u0000${cue.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
  }
  return out;
}

function SubtitleOverlayImpl({ cues, activeIndexes, mergeKaraoke, blind, onCharClick, highlightFor, blindHint }: SubtitleOverlayProps) {
  const groups = useMemo(() => (mergeKaraoke ? mergePerCharacterCueGroups(cues) : undefined), [cues, mergeKaraoke]);
  const shown = visibleCues(cues, activeIndexes, groups);
  const top = shown.filter((c) => (c.markup?.alignment ?? 2) >= 7);
  const bottom = shown.filter((c) => (c.markup?.alignment ?? 2) < 7);
  const render = (cue: SubtitleCue) => {
    const hl = highlightFor(cue);
    return (
      <div key={`${cue.index}-${cue.startMs}`} className={cx('k-sub-line', hl.explaining && 'is-explaining')} data-testid="overlay-cue" data-cue-index={cue.index}>
        <RubyText text={cue.text} highlight={hl.span} focusIndex={hl.focus} onCharClick={(i) => onCharClick(cue, i)} />
      </div>
    );
  };
  return (
    <div className={cx('k-sub-overlay', blind && 'is-blind')} aria-live="off" title={blind ? blindHint : undefined}>
      <div className="k-sub-overlay__top">{top.map(render)}</div>
      <div className="k-sub-overlay__bottom">{bottom.map(render)}</div>
    </div>
  );
}

export const SubtitleOverlay = memo(SubtitleOverlayImpl);
