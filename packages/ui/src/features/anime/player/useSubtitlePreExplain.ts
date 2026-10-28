/**
 * Sliding-window subtitle pre-explanation hook (`AnimeSettings.autoPreExplain`).
 *
 * Strategy:
 * - Looks ahead from the current playback row (`Math.max(0, currentRowIdx)`)
 *   and selects up to `BATCH_WINDOW_SIZE` (5) explainable subtitle rows
 *   (`>= 4` content characters after stripping punctuation/markers).
 * - Probes `host.ai.getCachedExplanation` first so already-cached lines light
 *   up with `✦` immediately at zero token cost.
 * - Sends all uncached lines in the window (up to 5 sentences) in a **single**
 *   `host.ai.explainBatch` request, writing each sentence into the shared
 *   `ExplanationCache` under its standard single-sentence cache key so clicking
 *   any pre-explained subtitle opens in 0 ms.
 */
import { useEffect, useRef, useState } from 'react';
import type { ExplainRequest, ExplainSource, Id, TranscriptRow } from '@kotori/core';
import { useHost } from '../../../host/HostContext';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { cueJapaneseText, subtitleExplainContext, toSubtitleContextRows, type SubtitleContextRow } from '../../../lib/cues';

type SubtitleSource = Extract<ExplainSource, { kind: 'subtitle' }>;

export const BATCH_WINDOW_SIZE = 5;
const LOOKAHEAD_SCAN_LIMIT = 12;

/**
 * Returns true if the subtitle line has at least 4 meaningful characters
 * (excluding whitespace, punctuation, musical notes, and pure interjections).
 */
export function isExplainableSubtitle(text: string): boolean {
  const stripped = text
    .replace(/^[（(][^）)]*[）)]$/u, '')
    .replace(/[\s\p{P}\p{S}♪〜ー…・]/gu, '');
  return stripped.length >= 4;
}

export function buildRowExplainRequest(params: {
  readonly row: TranscriptRow;
  readonly rowIndex: number;
  readonly contextRows: readonly SubtitleContextRow[];
  readonly episodeId: Id;
  readonly trackId: Id;
  readonly targetLanguage: ExplainRequest['targetLanguage'];
  readonly sceneHint?: string | undefined;
}): ExplainRequest {
  const { row, rowIndex, contextRows, episodeId, trackId, targetLanguage, sceneHint } = params;
  const cue = row.cue;
  // Must mirror `useSubtitleBreakdown.openCue` exactly (Japanese line only, shared context builder).
  const text = cueJapaneseText(cue);
  const source: SubtitleSource = {
    kind: 'subtitle',
    episodeId,
    trackId,
    cueIndexes: [cue.index],
    cueCharSpans: [[0, text.length]],
    startMs: cue.startMs,
    endMs: cue.endMs,
  };
  return {
    sentence: text,
    source,
    targetLanguage,
    ...subtitleExplainContext(contextRows, rowIndex),
    ...(sceneHint ? { sceneHint } : {}),
  };
}

export interface SubtitlePreExplainState {
  /** `TranscriptRow.rep` values whose explanation is ready in cache (`✦`). */
  readonly cachedCueIndexes: ReadonlySet<number>;
  /** `TranscriptRow.rep` values currently being prefetched (`◌`). */
  readonly prefetchingCueIndexes: ReadonlySet<number>;
}

export function useSubtitlePreExplain(params: {
  readonly enabled: boolean;
  readonly episodeId: Id;
  readonly trackId: Id | undefined;
  readonly rows: readonly TranscriptRow[];
  readonly currentRowIdx: number;
  readonly sceneHint?: string | undefined;
}): SubtitlePreExplainState {
  const { enabled, episodeId, trackId, rows, currentRowIdx, sceneHint } = params;
  const host = useHost();
  const targetLanguage = useSettingsStore((s) => s.settings.ai.targetLanguage);
  const explainModel = useSettingsStore((s) => s.settings.ai.explainModel);
  const activeExplanation = useBreakdownStore((s) => s.explanation);
  const activeRequest = useBreakdownStore((s) => s.request);

  const [cachedCueIndexes, setCachedCueIndexes] = useState<ReadonlySet<number>>(() => new Set());
  const [prefetchingCueIndexes, setPrefetchingCueIndexes] = useState<ReadonlySet<number>>(() => new Set());
  const [batchTick, setBatchTick] = useState(0);

  const cachedRef = useRef<Set<number>>(new Set());
  const prefetchingRef = useRef<Set<number>>(new Set());
  const probedRef = useRef<Set<number>>(new Set());
  const failedRef = useRef<Set<number>>(new Set());
  const inFlightRef = useRef(false);

  // Reset tracking sets when track, episode, model, or target language changes.
  useEffect(() => {
    cachedRef.current = new Set();
    prefetchingRef.current = new Set();
    probedRef.current = new Set();
    failedRef.current = new Set();
    inFlightRef.current = false;
    setCachedCueIndexes(new Set());
    setPrefetchingCueIndexes(new Set());
  }, [episodeId, trackId, targetLanguage, explainModel]);

  // Whenever a manual breakdown finishes for a single subtitle cue, mark it cached.
  useEffect(() => {
    if (!activeExplanation || !activeRequest || activeRequest.source.kind !== 'subtitle') return;
    if (activeRequest.source.episodeId !== episodeId || activeRequest.source.trackId !== trackId) return;
    if (activeRequest.source.cueIndexes.length === 1) {
      const rep = activeRequest.source.cueIndexes[0]!;
      if (!cachedRef.current.has(rep)) {
        cachedRef.current.add(rep);
        setCachedCueIndexes(new Set(cachedRef.current));
      }
    }
  }, [activeExplanation, activeRequest, episodeId, trackId]);

  // Sliding-window cache probe & 5-sentence batch pre-explanation.
  useEffect(() => {
    if (!trackId || rows.length === 0) return;
    let cancelled = false;

    const baseIdx = Math.max(0, currentRowIdx);
    const endIdx = Math.min(rows.length, baseIdx + LOOKAHEAD_SCAN_LIMIT);
    const contextRows = toSubtitleContextRows(rows.map((r) => r.cue));

    const run = async (): Promise<void> => {
      // 1. Probe cache for nearby rows not yet probed so `✦` badges appear even when toggle is off.
      const toProbe: { row: TranscriptRow; idx: number }[] = [];
      for (let i = baseIdx; i < endIdx; i++) {
        const row = rows[i];
        if (!row || probedRef.current.has(row.rep) || cachedRef.current.has(row.rep)) continue;
        probedRef.current.add(row.rep);
        toProbe.push({ row, idx: i });
      }
      if (toProbe.length > 0) {
        let added = false;
        await Promise.all(
          toProbe.map(async ({ row, idx }) => {
            const req = buildRowExplainRequest({ row, rowIndex: idx, contextRows, episodeId, trackId, targetLanguage, sceneHint });
            const hit = await host.ai.getCachedExplanation(req).catch(() => undefined);
            if (hit && !cachedRef.current.has(row.rep)) {
              cachedRef.current.add(row.rep);
              added = true;
            }
          }),
        );
        if (added && !cancelled) {
          setCachedCueIndexes(new Set(cachedRef.current));
        }
      }

      if (!enabled || cancelled || inFlightRef.current) return;

      // 2. Collect up to BATCH_WINDOW_SIZE (5) explainable rows in the lookahead window.
      const windowRows: { row: TranscriptRow; idx: number; req: ExplainRequest }[] = [];
      for (let i = baseIdx; i < endIdx && windowRows.length < BATCH_WINDOW_SIZE; i++) {
        const row = rows[i];
        if (!row) continue;
        if (!isExplainableSubtitle(cueJapaneseText(row.cue))) continue;
        if (cachedRef.current.has(row.rep) || prefetchingRef.current.has(row.rep) || failedRef.current.has(row.rep)) continue;
        const req = buildRowExplainRequest({ row, rowIndex: i, contextRows, episodeId, trackId, targetLanguage, sceneHint });
        windowRows.push({ row, idx: i, req });
      }

      if (windowRows.length === 0) return;

      inFlightRef.current = true;
      for (const item of windowRows) prefetchingRef.current.add(item.row.rep);
      setPrefetchingCueIndexes(new Set(prefetchingRef.current));

      try {
        const requests = windowRows.map((w) => w.req);
        if (host.ai.explainBatch) {
          await host.ai.explainBatch(requests);
        } else {
          for (const req of requests) {
            await host.ai.explain(req);
          }
        }
        for (const item of windowRows) {
          prefetchingRef.current.delete(item.row.rep);
          cachedRef.current.add(item.row.rep);
        }
        if (!cancelled) {
          setPrefetchingCueIndexes(new Set(prefetchingRef.current));
          setCachedCueIndexes(new Set(cachedRef.current));
          setBatchTick((n) => n + 1);
        }
      } catch {
        for (const item of windowRows) {
          prefetchingRef.current.delete(item.row.rep);
          failedRef.current.add(item.row.rep);
        }
        if (!cancelled) {
          setPrefetchingCueIndexes(new Set(prefetchingRef.current));
        }
      } finally {
        inFlightRef.current = false;
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled, episodeId, trackId, rows, currentRowIdx, targetLanguage, sceneHint, host, batchTick]);

  return { cachedCueIndexes, prefetchingCueIndexes };
}
