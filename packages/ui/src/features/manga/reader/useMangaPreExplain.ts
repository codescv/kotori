/**
 * Silent background pre-explanation for the current manga spread.
 *
 * When `enabled` (`settings.manga.autoPreExplain`), after the user stays on the
 * current spread for `500 ms`, collects up to 5 explainable OCR speech bubbles
 * (`>= 4` Japanese characters, skipping short interjections/SFX), checks
 * `host.ai.getCachedExplanation`, and sends uncached bubbles in a single
 * `host.ai.explainBatch` request.
 */
import { useEffect, useRef } from 'react';
import type { ExplainRequest, MangaPage } from '@kotori/core';
import { useHost } from '../../../host/HostContext';
import { useSettingsStore } from '../../../stores/settings';
import { blockContext } from './BlockOverlay';

const BATCH_SIZE = 5;
const STAY_DEBOUNCE_MS = 500;

const JAPANESE_CHAR_RE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g;

export function isExplainableBubbleText(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned.length < 4) return false;
  const matches = cleaned.match(JAPANESE_CHAR_RE);
  return (matches?.length ?? 0) >= 4;
}

export interface UseMangaPreExplainInput {
  readonly enabled: boolean;
  readonly volumeId: string;
  readonly spreadPages: readonly MangaPage[];
  readonly sceneHint?: string | undefined;
}

export function useMangaPreExplain({ enabled, volumeId, spreadPages, sceneHint }: UseMangaPreExplainInput): void {
  const host = useHost();
  const targetLanguage = useSettingsStore((s) => s.settings.ai.targetLanguage);
  const visitedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    visitedKeysRef.current.clear();
  }, [volumeId, targetLanguage]);

  const spreadKey = spreadPages.map((p) => p.index).join(',');

  useEffect(() => {
    if (!enabled || spreadPages.length === 0) return;

    const candidates: ExplainRequest[] = [];
    for (const page of spreadPages) {
      for (const block of page.blocks) {
        if (!isExplainableBubbleText(block.text)) continue;
        const key = `${page.index}:${block.index}`;
        if (visitedKeysRef.current.has(key)) continue;
        candidates.push({
          sentence: block.text,
          source: { kind: 'manga', volumeId, pageIndex: page.index, blockIndex: block.index },
          targetLanguage,
          ...blockContext(page, block.index),
          ...(sceneHint ? { sceneHint } : {}),
        });
        if (candidates.length >= BATCH_SIZE) break;
      }
      if (candidates.length >= BATCH_SIZE) break;
    }

    if (candidates.length === 0) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const uncached: ExplainRequest[] = [];
          for (const req of candidates) {
            if (controller.signal.aborted) return;
            const hit = await host.ai.getCachedExplanation(req);
            if (req.source.kind === 'manga') {
              visitedKeysRef.current.add(`${req.source.pageIndex}:${req.source.blockIndex ?? 0}`);
            }
            if (!hit) uncached.push(req);
          }
          if (uncached.length === 0 || controller.signal.aborted) return;
          if (host.ai.explainBatch) {
            await host.ai.explainBatch(uncached, { signal: controller.signal });
          } else {
            for (const req of uncached) {
              if (controller.signal.aborted) return;
              await host.ai.explain(req, { signal: controller.signal });
            }
          }
        } catch {
          // Silent background prefetch: ignore network/cancellation errors.
        }
      })();
    }, STAY_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, volumeId, spreadKey, spreadPages, sceneHint, targetLanguage, host]);
}
