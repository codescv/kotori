/**
 * Manga reader: single (RTL/LTR), spread (RTL/LTR) and webtoon modes.
 *
 * - Navigation is anchored on a page index, so changing the mode or the cover
 *   offset keeps the reader on the same page. In RTL modes ArrowLeft / the
 *   left edge advance (Japanese reading direction); LTR mirrors it.
 * - `.mokuro` blocks are clickable (`BlockOverlay`); raw pages get the VLM
 *   `BubbleSelectTool`; ✨ 陪读本页 opens `PageGuideSheet`.
 * - The AI breakdown docks as a SideSheet on expanded windows and a modal
 *   BottomSheet on phones (`AdaptiveSheet` + `BreakdownPanel`).
 * - Progress is saved (fire-and-forget, debounced) and neighbouring pages are
 *   preloaded (±`settings.manga.preloadPages`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MangaGuideBubble, MangaPage, MangaPageGuideResult, MangaReadingMode, MangaVolume } from '@kotori/core';
import { BreakdownPanel } from '../../../components/breakdown/AiBreakdownPanel';
import { CircularProgress } from '../../../components/m3/Progress';
import { cx } from '../../../components/m3/cx';
import { IconButton } from '../../../components/m3/IconButton';
import { Menu } from '../../../components/m3/Menu';
import { AdaptiveSheet } from '../../../components/m3/Sheet';
import type { IconName } from '../../../components/m3/Icon';
import { useHost } from '../../../host/HostContext';
import { useT } from '../../../i18n';
import { buildSpreads, spreadIndexForPage } from '../../../lib/manga';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { showSnackbar } from '../../../stores/snackbar';
import { BlockOverlay, blockContext } from './BlockOverlay';
import { BubbleSelectTool } from './BubbleSelectTool';
import { GuideMarkers, PageGuideSheet } from './PageGuideSheet';
import { ZoomPan } from './PageCanvas';
import { SpreadLayout } from './SpreadLayout';
import { useElementSize } from './useElementSize';
import { Webtoon } from './Webtoon';
import '../manga.css';

export interface ReaderProps {
  readonly volumeId: string;
  readonly onExit: () => void;
}

const MODES: readonly { readonly mode: MangaReadingMode; readonly icon: IconName }[] = [
  { mode: 'spread-rtl', icon: 'spread' },
  { mode: 'spread-ltr', icon: 'spread' },
  { mode: 'single-rtl', icon: 'single' },
  { mode: 'single-ltr', icon: 'single' },
  { mode: 'webtoon', icon: 'webtoon' },
];

export const isRtl = (mode: MangaReadingMode): boolean => mode === 'spread-rtl' || mode === 'single-rtl';

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function Reader({ volumeId, onExit }: ReaderProps) {
  const host = useHost();
  const t = useT();
  const mangaSettings = useSettingsStore((s) => s.settings.manga);
  const [volume, setVolume] = useState<MangaVolume | undefined>();
  const [pages, setPages] = useState<MangaPage[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [anchor, setAnchor] = useState(0);
  const [outlines, setOutlines] = useState(mangaSettings.showBlockOutlines);
  const [selectTool, setSelectTool] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guides, setGuides] = useState<ReadonlyMap<number, MangaPageGuideResult>>(new Map());
  const stageRef = useRef<HTMLDivElement>(null);
  const stage = useElementSize(stageRef);

  const breakdownOpen = useBreakdownStore((s) => s.isOpen);
  const closeBreakdown = useBreakdownStore((s) => s.close);

  // ---- load -----------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    Promise.all([host.manga.getVolume(volumeId), host.manga.getPages(volumeId)])
      .then(([v, ps]) => {
        if (!alive) return;
        setVolume(v);
        setPages([...ps]);
        setAnchor(Math.min(Math.max(0, v.progress?.pageIndex ?? 0), Math.max(0, ps.length - 1)));
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [host, volumeId]);

  // Close the breakdown when leaving the reader.
  useEffect(() => () => useBreakdownStore.getState().close(), []);

  const mode: MangaReadingMode = volume?.readingMode ?? mangaSettings.defaultReadingMode;
  const coverIsSingle = volume?.coverIsSingle ?? true;
  const rtl = isRtl(mode);
  const spreads = useMemo(() => (pages ? buildSpreads(pages, { mode, coverIsSingle }) : []), [pages, mode, coverIsSingle]);
  const spreadIdx = spreadIndexForPage(spreads, anchor);
  const spread = spreads[spreadIdx];
  const pageAt = useCallback((i: number) => pages?.[i], [pages]);
  const spreadPages = useMemo(() => (spread ? spread.pageIndexes.map((i) => pages?.[i]).filter((p): p is MangaPage => p !== undefined) : []), [spread, pages]);

  // ---- navigation -------------------------------------------------------------
  const go = useCallback(
    (delta: number) => {
      const next = spreads[Math.min(spreads.length - 1, Math.max(0, spreadIdx + delta))];
      if (next?.pageIndexes[0] !== undefined) setAnchor(next.pageIndexes[0]);
    },
    [spreads, spreadIdx],
  );
  const goNext = useCallback(() => go(1), [go]);
  const goPrev = useCallback(() => go(-1), [go]);

  // The listener is registered once and always calls the latest handler (kept
  // in a ref updated during render), so a key press right after a re-render
  // never sees stale spreads while passive effects are still pending.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent): void => {
    if (mode === 'webtoon') return;
    if (e.defaultPrevented || isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        if (rtl) goNext();
        else goPrev();
        break;
      case 'ArrowRight':
        if (rtl) goPrev();
        else goNext();
        break;
      case 'PageDown':
      case ' ':
        goNext();
        break;
      case 'PageUp':
        goPrev();
        break;
      case 'Home':
        setAnchor(0);
        break;
      case 'End':
        setAnchor(Math.max(0, (pages?.length ?? 1) - 1));
        break;
      case 'Escape':
        if (useBreakdownStore.getState().isOpen) useBreakdownStore.getState().close();
        else if (selectTool) setSelectTool(false);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyHandler.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- progress (debounced, fire-and-forget) -------------------------------------
  const loaded = pages !== undefined;
  const lastSaved = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    if (lastSaved.current === undefined) {
      // First render after load: the restored position is already persisted.
      lastSaved.current = anchor;
      return;
    }
    if (lastSaved.current === anchor) return;
    const timer = setTimeout(() => {
      lastSaved.current = anchor;
      void host.manga.saveProgress(volumeId, { pageIndex: anchor, updatedAt: Date.now() }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [host, volumeId, anchor, loaded]);

  // ---- preload neighbours -----------------------------------------------------------
  useEffect(() => {
    if (!pages || mode === 'webtoon' || typeof Image === 'undefined') return;
    const n = Math.max(0, mangaSettings.preloadPages);
    for (let d = -n; d <= n; d++) {
      const s = spreads[spreadIdx + d];
      if (!s || d === 0) continue;
      for (const i of s.pageIndexes) {
        const url = pages[i]?.imageUrl;
        if (url) new Image().src = url;
      }
    }
  }, [pages, spreads, spreadIdx, mode, mangaSettings.preloadPages]);

  // ---- volume settings ----------------------------------------------------------------
  const setMode = async (m: MangaReadingMode): Promise<void> => {
    try {
      setVolume(await host.manga.setReadingMode(volumeId, m));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };
  const toggleCover = async (): Promise<void> => {
    try {
      setVolume(await host.manga.setCoverIsSingle(volumeId, !coverIsSingle));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };
  const onPageUpdated = useCallback((p: MangaPage) => setPages((ps) => ps?.map((x) => (x.index === p.index ? p : x))), []);

  const sceneHint = volume ? (volume.seriesTitle ?? volume.title) : undefined;
  const pickGuideBubble = useCallback(
    (page: MangaPage, b: MangaGuideBubble) => {
      const block = b.blockIndex !== undefined ? page.blocks.find((x) => x.index === b.blockIndex) : undefined;
      void useBreakdownStore.getState().open(host, {
        sentence: block ? block.text : b.text,
        source: block ? { kind: 'manga', volumeId, pageIndex: page.index, blockIndex: block.index } : { kind: 'manga', volumeId, pageIndex: page.index },
        focusCharIndex: 0,
        ...(block ? blockContext(page, block.index) : {}),
        sceneHint,
      });
    },
    [host, volumeId, sceneHint],
  );

  const renderOverlay = (page: MangaPage) => (
    <>
      <BlockOverlay volumeId={volumeId} page={page} showOutlines={outlines} sceneHint={sceneHint} />
      {guideOpen && guides.get(page.index) && <GuideMarkers result={guides.get(page.index)!} page={page} onPick={pickGuideBubble} />}
      {selectTool && <BubbleSelectTool volumeId={volumeId} page={page} onPageUpdated={onPageUpdated} />}
    </>
  );

  // ---- render -------------------------------------------------------------------------
  const total = pages?.length ?? volume?.pageCount ?? 0;
  const pageLabel = spread ? spread.pageIndexes.map((i) => i + 1).join('–') : String(anchor + 1);
  const rawPage = spreadPages.some((p) => p.blocks.length === 0);

  return (
    <div className={cx('k-reader', `k-reader--bg-${mangaSettings.background}`)} data-testid="manga-reader" data-mode={mode}>
      <header className="k-reader__bar">
        <IconButton icon="back" label={t('common.back')} onClick={onExit} />
        <h1 className="k-reader__title k-title-medium" lang="ja" title={volume?.title}>
          {volume?.title ?? t('common.loading')}
        </h1>
        <span className="k-reader__page k-label-large" data-testid="page-indicator">
          {t('manga.reader.page', { current: pageLabel, total })}
        </span>
        <span className="k-spacer" />
        <Menu
          trigger={({ toggle }) => <IconButton icon={MODES.find((m) => m.mode === mode)?.icon ?? 'spread'} label={t('manga.reader.mode')} onClick={toggle} />}
          header={t('manga.reader.mode')}
          items={MODES.map((m) => ({ key: m.mode, label: t(`manga.mode.${m.mode}`), selected: m.mode === mode, onSelect: () => void setMode(m.mode) }))}
        />
        <IconButton
          icon="book"
          label={t('manga.reader.cover')}
          selected={coverIsSingle}
          disabled={!mode.startsWith('spread')}
          onClick={() => void toggleCover()}
          data-testid="cover-toggle"
        />
        <IconButton icon={outlines ? 'visibility' : 'visibilityOff'} label={t('manga.reader.outlines')} selected={outlines} onClick={() => setOutlines((o) => !o)} />
        <IconButton
          icon="crop"
          label={t('manga.reader.select')}
          selected={selectTool}
          variant={rawPage && !selectTool ? 'tonal' : 'standard'}
          onClick={() => setSelectTool((s) => !s)}
          data-testid="select-toggle"
        />
        <IconButton
          icon="sparkle"
          label={t('manga.reader.guide')}
          selected={guideOpen}
          onClick={() => {
            if (!guideOpen) closeBreakdown();
            setGuideOpen((g) => !g);
          }}
          data-testid="guide-toggle"
        />
      </header>

      <div className="k-reader__body">
        <div className="k-reader__stage-wrap">
          {error && <p className="k-error-text k-empty">{t('common.error', { message: error })}</p>}
          {!pages && !error && (
            <div className="k-empty">
              <CircularProgress label={t('common.loading')} />
            </div>
          )}
          {pages && mode === 'webtoon' && (
            <Webtoon pages={pages} initialPage={anchor} onPageChange={setAnchor} renderOverlay={renderOverlay} preload={Math.max(1, mangaSettings.preloadPages)} />
          )}
          {pages && mode !== 'webtoon' && spread && (
            <>
              <div className="k-reader__stage" ref={stageRef}>
                <ZoomPan disabled={selectTool} resetKey={spreadIdx}>
                  <SpreadLayout spread={spread} page={pageAt} mode={mode} stage={stage} fit={mangaSettings.fit} renderOverlay={renderOverlay} />
                </ZoomPan>
              </div>
              <button
                type="button"
                className="k-reader__edge k-reader__edge--left"
                aria-label={rtl ? t('manga.reader.next') : t('manga.reader.prev')}
                onClick={rtl ? goNext : goPrev}
                disabled={rtl ? spreadIdx >= spreads.length - 1 : spreadIdx <= 0}
              >
                <span className="k-reader__edge-icon">‹</span>
              </button>
              <button
                type="button"
                className="k-reader__edge k-reader__edge--right"
                aria-label={rtl ? t('manga.reader.prev') : t('manga.reader.next')}
                onClick={rtl ? goPrev : goNext}
                disabled={rtl ? spreadIdx <= 0 : spreadIdx >= spreads.length - 1}
              >
                <span className="k-reader__edge-icon">›</span>
              </button>
              {spreads.length > 1 && (
                <input
                  className={cx('k-reader__scrubber', rtl && 'is-rtl')}
                  type="range"
                  min={0}
                  max={spreads.length - 1}
                  value={spreadIdx}
                  aria-label={t('manga.reader.page', { current: pageLabel, total })}
                  onChange={(e) => {
                    const s = spreads[Number(e.currentTarget.value)];
                    if (s?.pageIndexes[0] !== undefined) setAnchor(s.pageIndexes[0]);
                  }}
                />
              )}
            </>
          )}
        </div>

        <AdaptiveSheet open={breakdownOpen} onClose={closeBreakdown} title={t('breakdown.title')} closeLabel={t('common.close')}>
          <BreakdownPanel />
        </AdaptiveSheet>
        <PageGuideSheet
          open={guideOpen && !breakdownOpen}
          onClose={() => setGuideOpen(false)}
          volumeId={volumeId}
          pages={spreadPages}
          results={guides}
          onResult={(r) => setGuides((m) => new Map(m).set(r.pageIndex, r))}
          onPick={pickGuideBubble}
        />
      </div>
    </div>
  );
}
