/**
 * ✨ 陪读本页 — page guide. Downscales each page of the current spread to
 * ≤ 1536 px, calls `ai.pageGuide` (anchored with known OCR blocks), and shows
 * the scene summary plus numbered bubbles; `GuideMarkers` draws the matching
 * numbers over the page. Picking a bubble opens the breakdown.
 */
import { useEffect, useState } from 'react';
import type { MangaGuideBubble, MangaPage, MangaPageGuideResult } from '@kotori/core';
import { AdaptiveSheet } from '../../../components/m3/Sheet';
import { Button } from '../../../components/m3/Button';
import { cx } from '../../../components/m3/cx';
import { LinearProgress } from '../../../components/m3/Progress';
import { useHost } from '../../../host/HostContext';
import { useT } from '../../../i18n';
import { useSettingsStore } from '../../../stores/settings';
import { downscalePageImage } from './crop';

export interface PageGuideSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly volumeId: string;
  readonly pages: readonly MangaPage[];
  readonly results: ReadonlyMap<number, MangaPageGuideResult>;
  readonly onResult: (result: MangaPageGuideResult) => void;
  readonly onPick: (page: MangaPage, bubble: MangaGuideBubble) => void;
}

export function PageGuideSheet({ open, onClose, volumeId, pages, results, onResult, onPick }: PageGuideSheetProps) {
  const host = useHost();
  const t = useT();
  const targetLanguage = useSettingsStore((s) => s.settings.ai.targetLanguage);
  const [running, setRunning] = useState<ReadonlySet<number>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<number, string>>(new Map());
  const [nonce, setNonce] = useState(0);

  const missing = pages.filter((p) => !results.has(p.index)).map((p) => p.index).join(',');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const todo = pages.filter((p) => !results.has(p.index));
    if (todo.length === 0) return;
    setRunning(new Set(todo.map((p) => p.index)));
    setErrors(new Map());
    void (async () => {
      for (const page of todo) {
        try {
          const image = await downscalePageImage(page.imageUrl, page);
          const res = await host.ai.pageGuide({ volumeId, pageIndex: page.index, image, targetLanguage, knownBlocks: page.blocks }, { signal: controller.signal });
          if (controller.signal.aborted) return;
          onResult(res);
        } catch (e) {
          if (controller.signal.aborted) return;
          setErrors((m) => new Map(m).set(page.index, e instanceof Error ? e.message : String(e)));
        } finally {
          if (!controller.signal.aborted) setRunning((s) => new Set([...s].filter((i) => i !== page.index)));
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, missing, volumeId, host, targetLanguage, nonce]);

  return (
    <AdaptiveSheet open={open} onClose={onClose} title={t('manga.guide.title')}>
      <div className="k-guide" data-testid="page-guide">
        {pages.map((page) => {
          const res = results.get(page.index);
          const err = errors.get(page.index);
          return (
            <section key={page.index} className="k-guide__page">
              {pages.length > 1 && <h3 className="k-title-small k-muted">p.{page.index + 1}</h3>}
              {running.has(page.index) && !res && (
                <div className="k-stack">
                  <LinearProgress label={t('manga.guide.running')} />
                  <p className="k-muted">{t('manga.guide.running')}</p>
                </div>
              )}
              {err && (
                <div className="k-stack">
                  <p className="k-error-text">{t('common.error', { message: err })}</p>
                  <Button variant="tonal" icon="refresh" onClick={() => setNonce((n) => n + 1)}>
                    {t('common.retry')}
                  </Button>
                </div>
              )}
              {res && (
                <>
                  <p className="k-guide__summary">
                    <span className="k-label-large">{t('manga.guide.summary')}</span>
                    <br />
                    {res.summary}
                  </p>
                  <ol className="k-guide__list">
                    {res.bubbles.map((b) => (
                      <li key={b.order}>
                        <button type="button" className="k-guide__item" onClick={() => onPick(page, b)} data-testid={`guide-item-${page.index}-${b.order}`}>
                          <span className="k-guide__num">{b.order}</span>
                          <span className="k-guide__body">
                            <span className="k-guide__text" lang="ja">
                              {b.text}
                            </span>
                            {b.speaker && <span className="k-muted k-label-medium">{t('manga.guide.speaker', { name: b.speaker })}</span>}
                            <span className="k-guide__translation">{b.translation}</span>
                            {b.note && <span className="k-guide__note">💡 {b.note}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>
          );
        })}
      </div>
    </AdaptiveSheet>
  );
}

/** Numbered markers over a page for a guide result (rects are 0..1 fractions). */
export function GuideMarkers({ result, onPick, page }: { readonly result: MangaPageGuideResult; readonly page: MangaPage; readonly onPick: (page: MangaPage, b: MangaGuideBubble) => void }) {
  return (
    <div className="k-guide-markers">
      {result.bubbles.map((b) => (
        <button
          key={b.order}
          type="button"
          className={cx('k-guide-marker', b.blockIndex !== undefined && 'is-anchored')}
          style={{ left: `${b.rectFraction.right * 100}%`, top: `${b.rectFraction.top * 100}%` }}
          title={b.translation}
          onClick={(e) => {
            e.stopPropagation();
            onPick(page, b);
          }}
        >
          {b.order}
        </button>
      ))}
    </div>
  );
}
