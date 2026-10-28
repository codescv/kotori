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
import { cueJapaneseText, cueOffsetToSentenceIndex, mergeCuesToSentence, subtitleExplainContext, toSubtitleContextRows } from '../../../lib/cues';
import { useBreakdownStore } from '../../../stores/breakdown';
import { inferWordSpanAt } from '../../../components/breakdown/RubyText';
import { deriveSelection } from '../../../components/breakdown/useBreakdownSelection';

type SubtitleSource = Extract<ExplainSource, { kind: 'subtitle' }>;

export interface CueHighlight {
  readonly span: CharSpan | undefined;
  readonly focus: number | undefined;
  readonly focusSpan?: CharSpan | undefined;
  /** This cue is part of the sentence currently explained. */
  readonly explaining: boolean;
}

const NONE: CueHighlight = { span: undefined, focus: undefined, focusSpan: undefined, explaining: false };

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

  const contextRows = useMemo(() => toSubtitleContextRows(contextCues), [contextCues]);
  const context = useCallback(
    (first: SubtitleCue, last: SubtitleCue) => {
      const i = contextCues.findIndex((c) => c.index === first.index);
      const j = contextCues.findIndex((c) => c.index === last.index);
      // Same builder as `useSubtitlePreExplain` ⇒ identical request ⇒ same cache key.
      return subtitleExplainContext(contextRows, i, j);
    },
    [contextCues, contextRows],
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
      // Bilingual fansub cues: only the Japanese line is explained.
      const text = cueJapaneseText(cue);
      const src: SubtitleSource = { kind: 'subtitle', episodeId, trackId, cueIndexes: [cue.index], cueCharSpans: [[0, text.length]], startMs: cue.startMs, endMs: cue.endMs };
      const focus = Math.max(0, Math.min(localCharIndex, text.length - 1));
      void store.open(host, { sentence: text, source: src, focusCharIndex: focus, sceneHint, ...context(cue, cue) });
    },
    [host, episodeId, trackId, sceneHint, context],
  );

  const openMerged = useCallback(
    (cues: readonly SubtitleCue[], focusCharIndex = 0) => {
      if (!trackId || cues.length === 0) return;
      const ordered = [...cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
      const merged = mergeCuesToSentence(ordered.map((c) => ({ ...c, text: cueJapaneseText(c) })));
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
  const sentenceFocusSpan = useMemo<CharSpan | undefined>(() => {
    if (focusCharIndex === undefined) return undefined;
    if (selection.focusWordSpan) return selection.focusWordSpan;
    return request ? inferWordSpanAt(request.sentence, focusCharIndex, explanation?.ruby, 0) : undefined;
  }, [focusCharIndex, selection.focusWordSpan, request, explanation?.ruby]);

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
      let focusSpan: CharSpan | undefined;
      if (sentenceFocusSpan) {
        const fs = Math.max(sentenceFocusSpan[0], cs[0]);
        const fe = Math.min(sentenceFocusSpan[1], cs[1]);
        if (fe > fs) focusSpan = [fs - cs[0], fe - cs[0]];
      }
      const focus = focusCharIndex !== undefined && focusCharIndex >= cs[0] && focusCharIndex < cs[1] ? focusCharIndex - cs[0] : undefined;
      return { span, focus, focusSpan, explaining: true };
    },
    [source, selection.highlightSpan, sentenceFocusSpan, focusCharIndex],
  );

  return { openCue, openMerged, highlightFor, source };
}
