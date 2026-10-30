/**
 * Subtitle overlay over the video: the cues on screen right now, rendered as
 * plain text (no libass) with every character clickable. Per-character ASS
 * karaoke events are shown once as their merged sentence when
 * `mergeKaraoke` is on. Hide-subtitles mode (`B`, `blind`) removes the lines
 * entirely (no blur / hover reveal — unusable on touch). Bilingual fansub cues
 * show the Japanese line as clickable ruby text and the translation line as a
 * plain, non-clickable sub-line (char indices stay relative to the Japanese).
 * The focused chunk of the open explanation is painted back onto the cue.
 */
import { memo, useMemo, useRef } from 'react';
import type { SubtitleCue } from '@kotori/core';
import { RubyText } from '../../../components/breakdown/RubyText';
import { cx } from '../../../components/m3/cx';
import {
  balanceSubtitleLines,
  computeBalancedBreakOffsets,
  dropDuplicateLines,
  isSignCue,
  mergePerCharacterCueGroups,
  splitBilingualCueText,
  translationTextOf,
  type LineBreakPlan,
} from '../../../lib/cues';
import type { CueHighlight } from './useSubtitleBreakdown';
import { useSubtitleLineMetrics, type SubtitleLineMetrics } from './useSubtitleLineMetrics';

export interface SubtitleOverlayProps {
  readonly cues: readonly SubtitleCue[];
  /** Array positions of the cues on screen. */
  readonly activeIndexes: readonly number[];
  readonly mergeKaraoke: boolean;
  readonly blind: boolean;
  readonly onCharClick: (cue: SubtitleCue, localCharIndex: number) => void;
  readonly highlightFor: (cue: SubtitleCue) => CueHighlight;
  readonly blindHint?: string;
  /** 副字幕 cues (already delay-shifted) and their active positions; both empty when no secondary. */
  readonly secondaryCues?: readonly SubtitleCue[] | undefined;
  readonly secondaryActiveIndexes?: readonly number[] | undefined;
  /** BCP-47-ish tag of the secondary track for the `lang` attribute (font selection for zh vs ja glyphs). */
  readonly secondaryLang?: string | undefined;
  /** Override responsive line-width measurements (used for deterministic wrapping tests). */
  readonly lineMetrics?: SubtitleLineMetrics | undefined;
  /** Line-clamp budget for secondary track (`1` in immersive when HUD is visible, else `2`). */
  readonly secondaryMaxLines?: 1 | 2 | undefined;
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

const normaliseLine = (s: string): string => s.replace(/[\s\u3000]+/g, '');

function toBalanceLang(tag: string | undefined): 'ja' | 'zh' | 'en' | undefined {
  if (!tag) return undefined;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('en')) return 'en';
  if (lower.startsWith('ja')) return 'ja';
  return undefined;
}

interface CueLayoutEntry {
  readonly primaryJa: string;
  readonly plan: LineBreakPlan;
  readonly inlineSecondary?: string | undefined;
}

function SubtitleOverlayImpl({
  cues,
  activeIndexes,
  mergeKaraoke,
  blind,
  onCharClick,
  highlightFor,
  blindHint,
  secondaryCues,
  secondaryActiveIndexes,
  secondaryLang,
  lineMetrics,
  secondaryMaxLines = 2,
}: SubtitleOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const primaryProbeRef = useRef<HTMLSpanElement>(null);
  const secondaryProbeRef = useRef<HTMLSpanElement>(null);
  const measured = useSubtitleLineMetrics(overlayRef, primaryProbeRef, secondaryProbeRef, blind);
  const metrics = lineMetrics ?? measured;

  const groups = useMemo(() => (mergeKaraoke ? mergePerCharacterCueGroups(cues) : undefined), [cues, mergeKaraoke]);
  const shown = useMemo(() => visibleCues(cues, activeIndexes, groups), [cues, activeIndexes, groups]);
  const top = shown.filter((c) => (c.markup?.alignment ?? 2) >= 7);
  const bottom = shown.filter((c) => (c.markup?.alignment ?? 2) < 7);
  const hasSecondaryTrack = Boolean(secondaryCues && secondaryCues.length > 0);

  const layoutByCueKey = useMemo(() => {
    const m = new Map<string, CueLayoutEntry>();
    for (const c of shown) {
      const isTop = (c.markup?.alignment ?? 2) >= 7;
      const mapKey = `${isTop ? 't' : 'b'}\u0000${c.text}`;
      if (m.has(mapKey)) continue;
      const { primaryJa, secondaryTranslation } = splitBilingualCueText(c.text);
      const maxPrimaryEm = isTop ? metrics.primaryMaxEm / 0.7 : metrics.primaryMaxEm;
      const maxInlineEm = isTop ? metrics.inlineSecondaryMaxEm / 0.7 : metrics.inlineSecondaryMaxEm;
      const plan = computeBalancedBreakOffsets(primaryJa, maxPrimaryEm);
      const inlineSecondary =
        !hasSecondaryTrack && secondaryTranslation
          ? balanceSubtitleLines(secondaryTranslation, maxInlineEm, { maxLines: 2 })
          : undefined;
      m.set(mapKey, { primaryJa, plan, inlineSecondary });
    }
    return m;
  }, [shown, metrics.primaryMaxEm, metrics.inlineSecondaryMaxEm, hasSecondaryTrack]);

  const secondaryBalanceLang = toBalanceLang(secondaryLang);
  const secondaryMaxEm = secondaryMaxLines === 1 ? Infinity : metrics.secondaryMaxEm;
  const secondaryShown = useMemo(() => {
    if (!secondaryCues?.length || !secondaryActiveIndexes?.length) return [];
    const primaryLines = new Set(shown.flatMap((c) => c.text.split(/\r?\n/).map(normaliseLine)).filter(Boolean));
    return visibleCues(secondaryCues, secondaryActiveIndexes, undefined)
      .filter((c) => (c.markup?.alignment ?? 2) < 7 && !isSignCue(c))
      .map((c) => {
        const own = dropDuplicateLines(c.text, primaryLines);
        const rawText = translationTextOf(own);
        const text =
          rawText.trim() === ''
            ? ''
            : balanceSubtitleLines(rawText, secondaryMaxEm, { lang: secondaryBalanceLang, maxLines: 2 });
        return { cue: c, text };
      })
      .filter((x) => x.text.trim() !== '');
  }, [shown, secondaryCues, secondaryActiveIndexes, secondaryMaxEm, secondaryBalanceLang]);

  const render = (cue: SubtitleCue) => {
    const hl = highlightFor(cue);
    const isTop = (cue.markup?.alignment ?? 2) >= 7;
    const entry = layoutByCueKey.get(`${isTop ? 't' : 'b'}\u0000${cue.text}`);
    const primaryJa = entry?.primaryJa ?? splitBilingualCueText(cue.text).primaryJa;
    return (
      <div
        key={`${cue.index}-${cue.startMs}`}
        className={cx('k-sub-line', hl.explaining && 'is-explaining')}
        data-testid="overlay-cue"
        data-cue-index={cue.index}
      >
        <RubyText
          text={primaryJa}
          highlight={hl.span}
          focusIndex={hl.focus}
          focusSpan={hl.focusSpan}
          softBreakOffsets={entry?.plan.softBreaks}
          joinHardBreakOffsets={entry?.plan.joinedHardBreaks}
          onCharClick={(i) => onCharClick(cue, i)}
        />
        {entry?.inlineSecondary && <span className="k-sub-line__secondary">{entry.inlineSecondary}</span>}
      </div>
    );
  };

  if (blind) {
    // Hidden subtitles: keep the (empty) overlay element so layout / tests can see the state.
    return <div ref={overlayRef} className="k-sub-overlay is-blind" aria-live="off" title={blindHint} data-testid="sub-overlay-hidden" />;
  }

  return (
    <div ref={overlayRef} className="k-sub-overlay" aria-live="off">
      <div className="k-sub-overlay__top">{top.map(render)}</div>
      <div className="k-sub-overlay__bottom">
        <span ref={primaryProbeRef} className="k-sub-line k-sub-line--probe" aria-hidden="true" />
        <span ref={secondaryProbeRef} className="k-sub-line k-sub-line--secondary k-sub-line--probe" aria-hidden="true" />
        {bottom.map(render)}
        {secondaryShown.map(({ cue, text }) => (
          <div
            key={`s-${cue.index}-${cue.startMs}`}
            className="k-sub-line k-sub-line--secondary"
            data-testid="overlay-secondary-cue"
            data-cue-index={cue.index}
            lang={secondaryLang}
          >
            <span className="k-sub-line--secondary__text">{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const SubtitleOverlay = memo(SubtitleOverlayImpl);
