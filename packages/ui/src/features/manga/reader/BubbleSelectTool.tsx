/**
 * VLM crop-to-explain for raw (non-OCR) pages: drag a rectangle over a bubble
 * → crop in the browser canvas (JPEG q0.9, long edge ≤ 1024 px) →
 * `ai.ocrBubble({ explain: true })` → breakdown panel. "Save block" persists
 * the recognised text as a `vlm` block via `manga.addBlocks`, after which it
 * behaves like a mokuro bubble.
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { MangaBlock, MangaBubbleOcrResult, MangaPage, MangaRect } from '@kotori/core';
import { Button } from '../../../components/m3/Button';
import { CircularProgress } from '../../../components/m3/Progress';
import { useHost } from '../../../host/HostContext';
import { useT } from '../../../i18n';
import { clientToPage, normaliseDragRect } from '../../../lib/manga';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { showSnackbar } from '../../../stores/snackbar';
import { cropPageImage, isUsableSelection } from './crop';

export interface BubbleSelectToolProps {
  readonly volumeId: string;
  readonly page: MangaPage;
  readonly onPageUpdated: (page: MangaPage) => void;
}

type Point = { x: number; y: number };

/** Block payload for `manga.addBlocks` from an OCR result. */
export function blockFromOcr(res: MangaBubbleOcrResult, zIndex: number): Omit<MangaBlock, 'index'> {
  const w = res.rect.right - res.rect.left;
  const h = res.rect.bottom - res.rect.top;
  const lines = res.lines.length > 0 ? res.lines : [res.text];
  const longest = Math.max(1, ...lines.map((l) => Array.from(l).length));
  const fontSize = Math.max(8, Math.round(res.vertical ? Math.min(w / lines.length, h / longest) : Math.min(h / lines.length, w / longest)));
  return {
    rect: res.rect,
    vertical: res.vertical,
    fontSize,
    zIndex,
    lines,
    text: lines.join(''),
    source: 'vlm',
    ...(res.confidence !== undefined ? { confidence: res.confidence } : {}),
  };
}

const pct = (v: number, of: number): string => `${(v / Math.max(1, of)) * 100}%`;

export function BubbleSelectTool({ volumeId, page, onPageUpdated }: BubbleSelectToolProps) {
  const host = useHost();
  const t = useT();
  const targetLanguage = useSettingsStore((s) => s.settings.ai.targetLanguage);
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null);
  const [selection, setSelection] = useState<MangaRect | undefined>();
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<MangaBubbleOcrResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const toPage = (e: PointerEvent<HTMLDivElement>): Point => clientToPage(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), page.width, page.height);

  const run = async (rect: MangaRect): Promise<void> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setStatus('running');
    setResult(undefined);
    setError(undefined);
    setSaved(false);
    try {
      const image = await cropPageImage(page.imageUrl, rect, page);
      const res = await host.ai.ocrBubble({ volumeId, pageIndex: page.index, rect, image, explain: true, targetLanguage }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(res);
      setStatus('done');
      const source = { kind: 'manga' as const, volumeId, pageIndex: page.index };
      if (res.explanation) useBreakdownStore.getState().show(res.explanation, source, 0);
      else if (res.text.trim()) void useBreakdownStore.getState().open(host, { sentence: res.text, source, focusCharIndex: 0 });
    } catch (e) {
      if (controller.signal.aborted || (e as { code?: string }).code === 'cancelled') return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  const save = async (): Promise<void> => {
    if (!result) return;
    try {
      const updated = await host.manga.addBlocks(volumeId, page.index, [blockFromOcr(result, page.blocks.length)]);
      setSaved(true);
      onPageUpdated(updated);
      showSnackbar(t('manga.reader.saved'));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };

  const live = drag ? normaliseDragRect(drag.a, drag.b, page.width, page.height) : selection;
  return (
    <div
      className="k-select-tool"
      data-testid={`select-tool-${page.index}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('.k-select-tool__result')) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const p = toPage(e);
        setDrag({ a: p, b: p });
      }}
      onPointerMove={(e) => drag && setDrag({ a: drag.a, b: toPage(e) })}
      onPointerUp={(e) => {
        if (!drag) return;
        const rect = normaliseDragRect(drag.a, toPage(e), page.width, page.height);
        setDrag(null);
        if (!isUsableSelection(rect)) return;
        setSelection(rect);
        void run(rect);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {!live && <div className="k-select-tool__hint">{t('manga.reader.selectHint')}</div>}
      {live && (
        <div
          className={`k-select-tool__rect${status === 'running' ? ' is-running' : ''}`}
          style={{ left: pct(live.left, page.width), top: pct(live.top, page.height), width: pct(live.right - live.left, page.width), height: pct(live.bottom - live.top, page.height) }}
        />
      )}
      {selection && !drag && status !== 'idle' && (
        <div
          className="k-select-tool__result"
          style={{ left: pct(Math.min(selection.left, page.width * 0.6), page.width), top: pct(Math.min(selection.bottom, page.height * 0.82), page.height) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {status === 'running' && (
            <span className="k-row">
              <CircularProgress size={20} /> {t('manga.reader.ocrRunning')}
            </span>
          )}
          {status === 'error' && <span className="k-error-text">{t('common.error', { message: error ?? '' })}</span>}
          {status === 'done' && result && (
            <>
              <p className="k-select-tool__text" lang="ja">
                {result.text}
              </p>
              {result.confidence !== undefined && <span className="k-muted k-label-medium">{Math.round(result.confidence * 100)}%</span>}
              <div className="k-row">
                <Button variant="tonal" icon={saved ? 'check' : 'add'} disabled={saved || !result.text.trim()} onClick={() => void save()}>
                  {saved ? t('manga.reader.saved') : t('manga.reader.saveBlock')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
