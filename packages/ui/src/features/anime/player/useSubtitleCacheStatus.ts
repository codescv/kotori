/**
 * Transcript cache badges for 「缓存AI解读」 — read-only, ZERO model calls.
 *
 * - On load (and whenever rows / track / target language / model change) the
 *   whole transcript is probed with ONE bulk `ai.getCachedStatus` call
 *   (`getCachedExplanation` fallback on older hosts) → `✦` for cached rows.
 * - Rows light up instantly when a manual breakdown finishes or a whole-video
 *   cache job (`useAiCacheStore`) completes a chunk (`◌` while in flight).
 *
 * Probed sentences are the rows' Japanese lines exactly as
 * `buildRowExplainRequest` / `useSubtitleBreakdown.openCue` send them, so the
 * cache keys match 100 %.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Id, TranscriptRow } from '@kotori/core';
import { useHost } from '../../../host/HostContext';
import { cueJapaneseText } from '../../../lib/cues';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { isExplainableJapaneseText } from '../../ai-cache/collect';
import { probeCachedStatus } from '../../ai-cache/runner';
import { cacheTag, useAiCacheStore } from '../../ai-cache/useAiCacheStore';

export interface SubtitleCacheStatus {
  /** `TranscriptRow.rep` values whose explanation is cached (`✦`). */
  readonly cachedCueIndexes: ReadonlySet<number>;
  /** `TranscriptRow.rep` values being cached right now (`◌`). */
  readonly cachingCueIndexes: ReadonlySet<number>;
  /** Unique explainable sentences in the transcript / how many are cached. */
  readonly explainableCount: number;
  readonly cachedExplainableCount: number;
}

const EMPTY: ReadonlySet<number> = new Set();

export function useSubtitleCacheStatus(params: {
  readonly episodeId: Id;
  readonly trackId: Id | undefined;
  readonly rows: readonly TranscriptRow[];
}): SubtitleCacheStatus {
  const { episodeId, trackId, rows } = params;
  const host = useHost();
  const targetLanguage = useSettingsStore((s) => s.settings.ai.targetLanguage);
  const model = useSettingsStore((s) => s.settings.ai.explainModel);
  const cachedTags = useAiCacheStore((s) => s.cachedTags);
  const cachingTags = useAiCacheStore((s) => s.cachingTags);
  const activeExplanation = useBreakdownStore((s) => s.explanation);

  /** Sentence tag per row (same tag scheme as the cache job store). */
  const rowTags = useMemo(() => rows.map((r) => cacheTag(cueJapaneseText(r.cue), targetLanguage, model)), [rows, targetLanguage, model]);

  const [probe, setProbe] = useState<{ readonly forRows: readonly TranscriptRow[]; readonly tags: ReadonlySet<string> }>({ forRows: [], tags: new Set() });
  const [manualTags, setManualTags] = useState<ReadonlySet<string>>(() => new Set());

  // One bulk probe per transcript (no LLM calls). Only the cache-key inputs matter
  // (sentence = the row's Japanese line exactly as `buildRowExplainRequest` / a click sends it).
  useEffect(() => {
    if (!trackId || rows.length === 0) return;
    let cancelled = false;
    const requests = rows.map((row) => ({ sentence: cueJapaneseText(row.cue), source: { kind: 'manual' as const }, targetLanguage }));
    void probeCachedStatus(host.ai, requests)
      .then((status) => {
        if (cancelled) return;
        const tags = new Set<string>();
        status.forEach((hit, i) => {
          if (hit) tags.add(cacheTag(requests[i]!.sentence, targetLanguage, model));
        });
        setProbe({ forRows: rows, tags });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, episodeId, trackId, rows, targetLanguage, model]);

  // A manual breakdown that finished (and was cached) lights up every row with that sentence.
  useEffect(() => {
    if (!activeExplanation || activeExplanation.degraded) return;
    // Produced under the current settings ⇒ tag with the current model (hosts may label models differently).
    const tag = cacheTag(activeExplanation.sentence, activeExplanation.targetLanguage, model);
    setManualTags((prev) => (prev.has(tag) ? prev : new Set([...prev, tag])));
  }, [activeExplanation, model]);

  return useMemo(() => {
    if (rows.length === 0) return { cachedCueIndexes: EMPTY, cachingCueIndexes: EMPTY, explainableCount: 0, cachedExplainableCount: 0 };
    const probed = probe.forRows === rows ? probe.tags : undefined;
    const cached = new Set<number>();
    const caching = new Set<number>();
    const explainable = new Set<string>();
    const explainableCached = new Set<string>();
    rows.forEach((row, i) => {
      const tag = rowTags[i]!;
      const isCached = Boolean(probed?.has(tag) || cachedTags.has(tag) || manualTags.has(tag));
      if (isCached) cached.add(row.rep);
      else if (cachingTags.has(tag)) caching.add(row.rep);
      if (isExplainableJapaneseText(cueJapaneseText(row.cue))) {
        explainable.add(tag);
        if (isCached) explainableCached.add(tag);
      }
    });
    return { cachedCueIndexes: cached, cachingCueIndexes: caching, explainableCount: explainable.size, cachedExplainableCount: explainableCached.size };
  }, [rows, rowTags, probe, cachedTags, cachingTags, manualTags]);
}
