/**
 * Subtitle ⇄ breakdown glue (ARCHITECTURE §6.2 step 1).
 *
 * - `openCue(cue, localCharIndex)`: a click in the overlay / transcript. If the
 *   open explanation already covers this cue (single or merged selection) the
 *   click is translated with `cueOffsetToSentenceIndex` and only moves the
 *   focus (0 ms); otherwise the cue's own text is explained.
 * - `openMerged(cues)`: multi-row selection → `mergeCuesToSentence` → explain.
 * - `highlightFor(cue)`: reverse mapping of the focused chunk back onto a cue
 *   (local `CharSpan` + focus) so the overlay/transcript light up too.
 */
import { useCallback, useMemo } from 'react';
import type { CharSpan, ExplainSource, Id, SubtitleCue } from '@kotori/core';
import { useHost } from '../../../host/HostContext';
import { cueOffsetToSentenceIndex, mergeCuesToSentence } from '../../../lib/cues';
import { useBreakdownStore } from '../../../stores/breakdown';
import { deriveSelection } from '../../../components/breakdown/useBreakdownSelection';

type SubtitleSource = Extract<ExplainSource, { kind: 'subtitle' }>;

export interface CueHighlight {
  readonly span: CharSpan | undefined;
  readonly focus: number | undefined;
  /** This cue is part of the sentence currently explained. */
  readonly explaining: boolean;
}

const NONE: CueHighlight = { span: undefined, focus: undefined, explaining: false };

export function useSubtitleBreakdown(params: {
  readonly episodeId: Id;
  readonly trackId: Id | undefined;
  /** Transcript texts in order (context lines for the prompt). */
  readonly contextCues: readonly SubtitleCue[];
  readonly sceneHint?: string | undefined;
}) {
  const host = useHost();
  const { episodeId, trackId, contextCues, sceneHint } = params;
  const request = useBreakdownStore((s) => s.request);
  const explanation = useBreakdownStore((s) => s.explanation);
  const focusCharIndex = useBreakdownStore((s) => s.focusCharIndex);

  const source: SubtitleSource | undefined =
    request?.source.kind === 'subtitle' && request.source.trackId === trackId && request.source.episodeId === episodeId ? request.source : undefined;

  const context = useCallback(
    (first: SubtitleCue, last: SubtitleCue) => {
      const i = contextCues.findIndex((c) => c.index === first.index);
      const j = contextCues.findIndex((c) => c.index === last.index);
      return {
        contextBefore: i > 0 ? contextCues.slice(Math.max(0, i - 3), i).map((c) => c.text) : undefined,
        contextAfter: j >= 0 ? contextCues.slice(j + 1, j + 3).map((c) => c.text) : undefined,
      };
    },
    [contextCues],
  );

  const openCue = useCallback(
    (cue: SubtitleCue, localCharIndex: number) => {
      if (!trackId) return;
      const store = useBreakdownStore.getState();
      const current = store.request?.source;
      if (current?.kind === 'subtitle' && current.trackId === trackId && current.episodeId === episodeId && current.cueIndexes.includes(cue.index) && store.request) {
        // Same sentence → pure focus change.
        void store.open(host, { sentence: store.request.sentence, source: current, focusCharIndex: cueOffsetToSentenceIndex(current, cue.index, localCharIndex) });
        return;
      }
      const src: SubtitleSource = { kind: 'subtitle', episodeId, trackId, cueIndexes: [cue.index], cueCharSpans: [[0, cue.text.length]], startMs: cue.startMs, endMs: cue.endMs };
      void store.open(host, { sentence: cue.text, source: src, focusCharIndex: localCharIndex, sceneHint, ...context(cue, cue) });
    },
    [host, episodeId, trackId, sceneHint, context],
  );

  const openMerged = useCallback(
    (cues: readonly SubtitleCue[], focusCharIndex = 0) => {
      if (!trackId || cues.length === 0) return;
      const ordered = [...cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
      const merged = mergeCuesToSentence(ordered);
      const src: SubtitleSource = { kind: 'subtitle', episodeId, trackId, cueIndexes: merged.cueIndexes, cueCharSpans: merged.cueCharSpans, startMs: merged.startMs, endMs: merged.endMs };
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      void useBreakdownStore
        .getState()
        .open(host, { sentence: merged.text, source: src, focusCharIndex, sceneHint, ...(first && last ? context(first, last) : {}) });
    },
    [host, episodeId, trackId, sceneHint, context],
  );

  const selection = useMemo(() => deriveSelection(explanation, focusCharIndex), [explanation, focusCharIndex]);

  const highlightFor = useCallback(
    (cue: SubtitleCue): CueHighlight => {
      if (!source) return NONE;
      const k = source.cueIndexes.indexOf(cue.index);
      const cs = source.cueCharSpans[k];
      if (k < 0 || !cs) return NONE;
      const hl = selection.highlightSpan;
      let span: CharSpan | undefined;
      if (hl) {
        const s = Math.max(hl[0], cs[0]);
        const e = Math.min(hl[1], cs[1]);
        if (e > s) span = [s - cs[0], e - cs[0]];
      }
      const focus = focusCharIndex !== undefined && focusCharIndex >= cs[0] && focusCharIndex < cs[1] ? focusCharIndex - cs[0] : undefined;
      return { span, focus, explaining: true };
    },
    [source, selection.highlightSpan, focusCharIndex],
  );

  return { openCue, openMerged, highlightFor, source };
}
