/**
 * Transcript (jump panel): merged/de-duplicated `TranscriptRow`s with
 * auto-follow of the playing line, search, click-to-seek (timestamp), per-char
 * click → breakdown, and multi-select (shift-click, select mode, or long-press
 * on touch) → "合并解析" which explains the rows as one sentence via
 * `mergeCuesToSentence`. ASS speakers (`Name`) render as a compact `[Actor]`
 * chip; bilingual fansub cues show the Japanese line (the part sent to Gemini)
 * with the translation as a subtle, tap-to-expand sub-line.
 *
 * Performance (long episodes have 500–1,000+ rows):
 * - the panel shell re-renders on every clock tick but only derives the active /
 *   scroll-target row; the memoized list body re-renders only when those change;
 * - rows are `memo`'d with stable callbacks, so a row change touches ≤ 2 rows;
 * - beyond `LAZY_GLYPHS_MIN_ROWS`, inactive rows render their text as one plain
 *   text node (`RubyText lazyGlyphs`) instead of one `<span>` per character;
 * - beyond `VIRTUALIZE_MIN_ROWS`, only a window of rows around the viewport (and
 *   the auto-follow target) is mounted, with spacer `<li>`s for the rest;
 * - wheel / touch / scroll listeners are native and passive.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { SubtitleCue, TranscriptRow } from '@kotori/core';
import { RubyText } from '../../../components/breakdown/RubyText';
import { Button } from '../../../components/m3/Button';
import { cx } from '../../../components/m3/cx';
import { IconButton } from '../../../components/m3/IconButton';
import { TextField } from '../../../components/m3/TextField';
import { useIsInactiveTabSlide } from '../../../components/m3/tabSlideContext';
import type { Translate } from '../../../i18n';
import { cueActor, formatClock, splitBilingualCueText } from '../../../lib/cues';
import type { CueHighlight } from './useSubtitleBreakdown';

export interface TranscriptPanelProps {
  readonly rows: readonly TranscriptRow[];
  /** Raw `SubtitleCue.index` values currently on screen. */
  readonly activeRawIndexes: ReadonlySet<number>;
  readonly currentMs: number;
  readonly selected: ReadonlySet<number>;
  readonly onSelectedChange: (next: ReadonlySet<number>) => void;
  readonly onSeek: (row: TranscriptRow) => void;
  readonly onCharClick: (cue: SubtitleCue, localCharIndex: number) => void;
  readonly onExplainSelection: (rows: readonly TranscriptRow[]) => void;
  readonly highlightFor: (cue: SubtitleCue) => CueHighlight;
  readonly cachedCueIndexes?: ReadonlySet<number> | undefined;
  readonly cachingCueIndexes?: ReadonlySet<number> | undefined;
  /** 副字幕 text per `row.rep`, used when the row has no inline bilingual translation. */
  readonly secondaryTextByRep?: ReadonlyMap<number, string> | undefined;
  /** Whether to prefer scrolling to `explaining` row on mount before playback moves (default `true`). */
  readonly preferExplainingOnMount?: boolean | undefined;
  /** Extra toolbar control (e.g. 「缓存AI解读」 on phones). */
  readonly toolbarExtra?: ReactNode;
  readonly t: Translate;
}

/** Above this many (filtered) rows, inactive rows render plain text instead of per-char glyph spans. */
export const LAZY_GLYPHS_MIN_ROWS = 60;
/** Above this many (filtered) rows, the list is windowed. */
export const VIRTUALIZE_MIN_ROWS = 80;
/** Rows mounted above and below the viewport when windowed. */
export const VIRTUAL_OVERSCAN = 30;
/** Height guess for rows that have not been measured yet. */
export const ESTIMATED_ROW_HEIGHT = 54;
/** Viewport height guess when the scroller reports none (hidden pane, jsdom). */
const FALLBACK_VIEWPORT_PX = 800;
const USER_SCROLL_HOLD_MS = 3000;

/** Index of the row that is playing: overlapping raw indexes first, then time window. */
export function activeRowIndex(rows: readonly TranscriptRow[], activeRaw: ReadonlySet<number>, ms: number): number {
  let byTime = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.rawIndexes.some((r) => activeRaw.has(r))) return i;
    if (row.cue.startMs <= ms && ms < Math.max(row.chainEndMs, row.cue.endMs)) byTime = i;
  }
  return byTime;
}

/**
 * Target row index for scrolling:
 * - Active cue when no different cue is being explained;
 * - Explained cue when returning from the AI breakdown tab (`preferExplaining`) or at `00:00`;
 * - Active cue during playback;
 * - Otherwise (`activeIdx < 0` and `ms > 0`): an upcoming cue within 600 ms
 *   (e.g. right after `jumpToRow` pre-roll), else the most recent cue with `startMs <= ms`.
 */
export function scrollTargetRowIndex(
  rows: readonly TranscriptRow[],
  activeIdx: number,
  ms: number,
  highlightFor: (cue: SubtitleCue) => CueHighlight,
  preferExplaining = false,
): number {
  const explainingIdx = rows.findIndex((r) => highlightFor(r.cue).explaining);
  const activeRow = activeIdx >= 0 ? rows[activeIdx] : undefined;
  if (
    activeIdx >= 0 &&
    (explainingIdx < 0 || explainingIdx === activeIdx || (activeRow !== undefined && highlightFor(activeRow.cue).explaining))
  ) {
    return activeIdx;
  }
  if (explainingIdx >= 0 && (preferExplaining || ms <= 0)) {
    return explainingIdx;
  }
  if (activeIdx >= 0) {
    return activeIdx;
  }
  if (ms > 0) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const delta = row.cue.startMs - ms;
      if (delta >= 0 && delta <= 600) return i;
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row && row.cue.startMs <= ms) return i;
    }
  }
  return -1;
}

interface RowProps {
  readonly row: TranscriptRow;
  readonly active: boolean;
  readonly selected: boolean;
  readonly selectMode: boolean;
  readonly highlight: CueHighlight;
  readonly cached: boolean;
  readonly prefetching: boolean;
  readonly cachedTitle: string;
  readonly prefetchingTitle: string;
  readonly secondaryText?: string | undefined;
  /** Long list: render the text as plain text unless active / explained. */
  readonly lazyText: boolean;
  readonly onRowClick: (row: TranscriptRow, shift: boolean) => void;
  readonly onSeek: (row: TranscriptRow) => void;
  readonly onCharClick: (cue: SubtitleCue, i: number) => void;
  readonly onLongPress: (row: TranscriptRow) => void;
}

const Row = memo(function Row({
  row,
  active,
  selected,
  selectMode,
  highlight,
  cached,
  prefetching,
  cachedTitle,
  prefetchingTitle,
  secondaryText,
  lazyText,
  onRowClick,
  onSeek,
  onCharClick,
  onLongPress,
}: RowProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const onPointerDown = useCallback(
    (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return;
      longPressed.current = false;
      timer.current = setTimeout(() => {
        longPressed.current = true;
        onLongPress(row);
      }, 500);
    },
    [onLongPress, row],
  );
  const cancel = useCallback((): void => clearTimeout(timer.current), []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = useCallback(
    (e: MouseEvent): void => {
      if (longPressed.current) {
        longPressed.current = false;
        return;
      }
      onRowClick(row, e.shiftKey);
    },
    [onRowClick, row],
  );
  const onTimeClick = useCallback(
    (e: MouseEvent): void => {
      e.stopPropagation();
      onSeek(row);
    },
    [onSeek, row],
  );
  const onTextClick = useCallback(
    (e: MouseEvent): void => {
      // Text clicks open the breakdown unless we are selecting rows.
      if (!selectMode && !e.shiftKey) e.stopPropagation();
    },
    [selectMode],
  );
  const handleCharClick = useCallback((i: number) => onCharClick(row.cue, i), [onCharClick, row.cue]);
  const actor = cueActor(row.cue);
  const { primaryJa, secondaryTranslation } = useMemo(() => splitBilingualCueText(row.cue.text), [row.cue.text]);
  const translation = secondaryTranslation ?? secondaryText;
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const lazyGlyphs =
    lazyText && !active && !highlight.explaining && !highlight.span && highlight.focus === undefined && !highlight.focusSpan;
  return (
    <li
      className={cx('k-transcript__row', active && 'is-active', selected && 'is-selected', highlight.explaining && 'is-explaining')}
      data-testid="transcript-row"
      data-rep={row.rep}
      aria-selected={selected}
      onPointerDown={onPointerDown}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onClick={onClick}
    >
      <button type="button" className="k-transcript__time" onClick={onTimeClick}>
        {formatClock(row.cue.startMs)}
      </button>
      <div className="k-transcript__body">
        {actor && (
          <span className="k-transcript__actor" title={actor} data-testid="transcript-actor">
            [{actor}]
          </span>
        )}
        <div className="k-transcript__text" onClick={onTextClick}>
          <RubyText
            text={primaryJa}
            highlight={highlight.span}
            focusIndex={highlight.focus}
            focusSpan={highlight.focusSpan}
            lazyGlyphs={lazyGlyphs}
            onCharClick={selectMode ? undefined : handleCharClick}
          />
        </div>
        {translation && (
          <button
            type="button"
            className={cx('k-transcript__secondary', secondaryOpen && 'is-open')}
            data-testid="transcript-secondary"
            aria-expanded={secondaryOpen}
            onClick={(e) => {
              e.stopPropagation();
              setSecondaryOpen((o) => !o);
            }}
          >
            {translation}
          </button>
        )}
      </div>
      {!selectMode && cached && (
        <span className="k-transcript__badge k-transcript__badge--cached" title={cachedTitle} data-testid="cue-cached">
          ✦
        </span>
      )}
      {!selectMode && !cached && prefetching && (
        <span className="k-transcript__badge k-transcript__badge--prefetching" title={prefetchingTitle} data-testid="cue-caching">
          ◌
        </span>
      )}
      {selectMode && <span className={cx('k-transcript__check', selected && 'is-on')} aria-hidden />}
    </li>
  );
});

/** Nearest vertically scrollable ancestor (the list itself, a sheet body, …); `null` = the document. */
function findScroller(el: HTMLElement): HTMLElement | null {
  const win = el.ownerDocument.defaultView;
  if (!win || typeof win.getComputedStyle !== 'function') return null;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node === el.ownerDocument.body || node === el.ownerDocument.documentElement) return null;
    if (/(auto|scroll|overlay)/.test(win.getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** `offsets[i]` = top of row `i` in list coordinates; `offsets[n]` = total height. */
export function rowOffsets(rows: readonly TranscriptRow[], heights: ReadonlyMap<number, number>): number[] {
  let sum = 0;
  let count = 0;
  for (const h of heights.values()) {
    sum += h;
    count++;
  }
  const estimate = count >= 5 ? sum / count : ESTIMATED_ROW_HEIGHT;
  const out = new Array<number>(rows.length + 1);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    out[i] = y;
    const row = rows[i];
    y += (row && heights.get(row.rep)) || estimate;
  }
  out[rows.length] = y;
  return out;
}

/** Visible `[start, end)` row range for a viewport `[top, top + height)` in list coordinates. */
export function visibleRowRange(offsets: readonly number[], top: number, height: number): readonly [number, number] {
  const n = offsets.length - 1;
  if (n <= 0) return [0, 0];
  // First row whose bottom is below `top`.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid + 1] ?? 0) > top) hi = mid;
    else lo = mid + 1;
  }
  const start = lo;
  let end = start;
  const bottom = top + height;
  while (end < n && (offsets[end] ?? 0) < bottom) end++;
  return [start, Math.max(end, Math.min(n, start + 1))];
}

interface Range {
  readonly start: number;
  readonly end: number;
}

function clampRange(r: Range, n: number): Range {
  const start = Math.max(0, Math.min(r.start, Math.max(0, n - 1)));
  const end = Math.min(n, Math.max(r.end, start + 1));
  return r.start === start && r.end === end ? r : { start, end };
}

function rangeAround(idx: number, n: number, visibleRows: number): Range {
  const half = Math.ceil(visibleRows / 2);
  return { start: Math.max(0, idx - half - VIRTUAL_OVERSCAN), end: Math.min(n, idx + half + VIRTUAL_OVERSCAN + 1) };
}

export function TranscriptPanel({
  rows,
  activeRawIndexes,
  currentMs,
  highlightFor,
  preferExplainingOnMount = true,
  ...rest
}: TranscriptPanelProps) {
  const [query, setQuery] = useState('');
  const isInitialMountRef = useRef(true);
  const mountedAtMsRef = useRef(currentMs);
  if (currentMs !== mountedAtMsRef.current) {
    isInitialMountRef.current = false;
  }

  const filtered = useMemo(() => {
    const q = query.trim();
    return q ? rows.filter((r) => r.cue.text.includes(q)) : rows;
  }, [rows, query]);
  // Cheap per-tick derivations; the list body below only re-renders when these change.
  const activeIdx = useMemo(() => activeRowIndex(filtered, activeRawIndexes, currentMs), [filtered, activeRawIndexes, currentMs]);
  const preferExplaining = preferExplainingOnMount && isInitialMountRef.current;
  const targetIdx = useMemo(
    () => scrollTargetRowIndex(filtered, activeIdx, currentMs, highlightFor, preferExplaining),
    [filtered, activeIdx, currentMs, highlightFor, preferExplaining],
  );

  return (
    <TranscriptBody
      {...rest}
      rows={rows}
      filtered={filtered}
      query={query}
      onQueryChange={setQuery}
      activeIdx={activeIdx}
      targetIdx={targetIdx}
      highlightFor={highlightFor}
    />
  );
}

interface TranscriptBodyProps extends Omit<TranscriptPanelProps, 'activeRawIndexes' | 'currentMs' | 'preferExplainingOnMount'> {
  readonly filtered: readonly TranscriptRow[];
  readonly query: string;
  readonly onQueryChange: (q: string) => void;
  readonly activeIdx: number;
  readonly targetIdx: number;
}

const TranscriptBody = memo(function TranscriptBody({
  rows,
  filtered,
  query,
  onQueryChange,
  activeIdx,
  targetIdx,
  selected,
  onSelectedChange,
  onSeek,
  onCharClick,
  onExplainSelection,
  highlightFor,
  cachedCueIndexes,
  cachingCueIndexes,
  secondaryTextByRep,
  toolbarExtra,
  t,
}: TranscriptBodyProps) {
  const [follow, setFollow] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const userScrollUntil = useRef(0);
  const initialScrollPendingRef = useRef(true);
  const inactiveSlide = useIsInactiveTabSlide();
  const targetRep = filtered[targetIdx]?.rep;
  const n = filtered.length;

  // --- windowing -----------------------------------------------------------------
  const virtual = n > VIRTUALIZE_MIN_ROWS;
  const heightsRef = useRef(new Map<number, number>());
  const visibleRowsRef = useRef(Math.ceil(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_HEIGHT));
  const [rangeState, setRange] = useState<Range>(() => rangeAround(Math.max(0, targetIdx), n, visibleRowsRef.current));
  let range = virtual ? clampRange(rangeState, n) : { start: 0, end: n };
  const following = follow && !inactiveSlide && Date.now() >= userScrollUntil.current;
  // Jump-to-target: the auto-follow target must be mounted before the scroll effect runs.
  const jumpedRef = useRef(false);
  if (virtual && following && targetIdx >= 0 && (targetIdx < range.start || targetIdx >= range.end)) {
    range = rangeAround(targetIdx, n, visibleRowsRef.current);
    jumpedRef.current = true;
  }
  if (virtual && (range.start !== rangeState.start || range.end !== rangeState.end)) setRange(range);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const followRef = useRef({ following, targetIdx });
  followRef.current = { following, targetIdx };
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  /** Scroll anchor: a mounted row and its offset in the list, captured before a window change. */
  const anchorRef = useRef<{ rep: number; offset: number } | undefined>(undefined);

  const offsets = virtual ? rowOffsets(filtered, heightsRef.current) : undefined;
  const topSpacer = offsets ? (offsets[range.start] ?? 0) : 0;
  const bottomSpacer = offsets ? (offsets[n] ?? 0) - (offsets[range.end] ?? 0) : 0;

  const recompute = useCallback(() => {
    const list = listRef.current;
    const rowsNow = filteredRef.current;
    const count = rowsNow.length;
    if (!list || count <= VIRTUALIZE_MIN_ROWS) return;
    const scroller = findScroller(list);
    const listRect = list.getBoundingClientRect();
    let viewTop: number;
    let viewHeight: number;
    if (scroller === list) {
      viewTop = list.scrollTop;
      viewHeight = list.clientHeight;
    } else if (scroller) {
      viewTop = scroller.getBoundingClientRect().top - listRect.top;
      viewHeight = scroller.clientHeight;
    } else {
      viewTop = -listRect.top;
      viewHeight = list.ownerDocument.defaultView?.innerHeight ?? 0;
    }
    if (!(viewHeight > 0)) viewHeight = FALLBACK_VIEWPORT_PX;
    const offs = rowOffsets(rowsNow, heightsRef.current);
    const [visStart, visEnd] = visibleRowRange(offs, Math.max(0, viewTop), viewHeight);
    visibleRowsRef.current = Math.max(1, visEnd - visStart);
    const cur = rangeRef.current;
    const margin = Math.floor(VIRTUAL_OVERSCAN / 3);
    if (cur.start <= Math.max(0, visStart - margin) && cur.end >= Math.min(count, visEnd + margin)) return;
    const { following: f, targetIdx: tgt } = followRef.current;
    // Keep the follow target mounted while a programmatic scroll is on its way to it.
    if (f && tgt >= 0 && (tgt < visStart || tgt >= visEnd) && tgt >= cur.start && tgt < cur.end) return;
    const next: Range = { start: Math.max(0, visStart - VIRTUAL_OVERSCAN), end: Math.min(count, visEnd + VIRTUAL_OVERSCAN) };
    // Anchor on the first visible mounted row so measurement corrections do not move content.
    const anchorRow = rowsNow[Math.max(cur.start, Math.min(visStart, cur.end - 1))];
    const anchorEl = anchorRow ? list.querySelector<HTMLElement>(`[data-rep="${anchorRow.rep}"]`) : null;
    anchorRef.current = anchorEl && anchorRow ? { rep: anchorRow.rep, offset: anchorEl.getBoundingClientRect().top - listRect.top } : undefined;
    setRange(next);
  }, []);

  // Measure mounted rows (cached by rep) and undo content shifts above the viewport.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!virtual || !list) return;
    list.querySelectorAll<HTMLElement>('[data-testid="transcript-row"]').forEach((el) => {
      // Fractional heights: rounding errors would accumulate in the spacers.
      const h = el.getBoundingClientRect().height;
      const rep = Number(el.dataset.rep);
      if (h > 0 && Math.abs((heightsRef.current.get(rep) ?? 0) - h) > 0.01) heightsRef.current.set(rep, h);
    });
    const anchor = anchorRef.current;
    anchorRef.current = undefined;
    if (!anchor) return;
    const el = list.querySelector<HTMLElement>(`[data-rep="${anchor.rep}"]`);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) < 1) return;
    const scroller = findScroller(list);
    if (scroller) scroller.scrollTop += delta;
    else list.ownerDocument.defaultView?.scrollBy?.(0, delta);
  });

  // Re-derive the window when the rows change (search, new track).
  useLayoutEffect(() => {
    if (virtual) recompute();
  }, [filtered, virtual, recompute]);

  // Native passive listeners: user scroll intent (wheel / touch) + rAF-coalesced window updates.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const markUserScroll = (): void => {
      userScrollUntil.current = Date.now() + USER_SCROLL_HOLD_MS;
    };
    let raf = 0;
    const onScroll = (): void => {
      if (raf || typeof requestAnimationFrame !== 'function') return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    const scroller = findScroller(list);
    const scrollTarget: HTMLElement | Window | null = scroller ?? list.ownerDocument.defaultView;
    const opts: AddEventListenerOptions = { passive: true };
    list.addEventListener('wheel', markUserScroll, opts);
    list.addEventListener('touchmove', markUserScroll, opts);
    scrollTarget?.addEventListener('scroll', onScroll, opts);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onScroll) : undefined;
    ro?.observe(scroller ?? list);
    return () => {
      list.removeEventListener('wheel', markUserScroll);
      list.removeEventListener('touchmove', markUserScroll);
      scrollTarget?.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [recompute]);

  useEffect(() => {
    // A transcript peeked next to AI 解析 during a SideSheet drag must not scroll the sheet.
    if (inactiveSlide) return;
    if (!follow || targetRep === undefined || Date.now() < userScrollUntil.current) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-rep="${targetRep}"]`);
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const isInitial = initialScrollPendingRef.current;
    initialScrollPendingRef.current = false;
    // A far jump in a windowed list lands instantly (no smooth flight over unmounted spacer).
    const jumped = jumpedRef.current;
    jumpedRef.current = false;
    el.scrollIntoView(jumped && !isInitial ? { block: 'center' } : { block: 'center', behavior: 'smooth' });
    if (!isInitial || typeof requestAnimationFrame !== 'function') return;
    const raf = requestAnimationFrame(() => {
      const target = listRef.current?.querySelector<HTMLElement>(`[data-rep="${targetRep}"]`);
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [targetRep, follow, inactiveSlide]);

  const toggle = useCallback(
    (rep: number): void => {
      const next = new Set(selected);
      if (next.has(rep)) next.delete(rep);
      else next.add(rep);
      onSelectedChange(next);
    },
    [selected, onSelectedChange],
  );
  const onRowClick = useCallback(
    (row: TranscriptRow, shift: boolean): void => {
      if (selectMode || shift) toggle(row.rep);
      else onSeek(row);
    },
    [selectMode, toggle, onSeek],
  );
  const onLongPress = useCallback(
    (row: TranscriptRow): void => {
      setSelectMode(true);
      toggle(row.rep);
    },
    [toggle],
  );
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.rep)), [rows, selected]);
  const lazyText = n > LAZY_GLYPHS_MIN_ROWS;
  const cachedTitle = t('transcript.cached');
  const prefetchingTitle = t('transcript.caching');

  const items: ReactNode[] = [];
  for (let i = range.start; i < range.end; i++) {
    const row = filtered[i];
    if (!row) continue;
    items.push(
      <Row
        key={row.rep}
        row={row}
        active={i === activeIdx}
        selected={selected.has(row.rep)}
        selectMode={selectMode}
        highlight={highlightFor(row.cue)}
        cached={Boolean(cachedCueIndexes?.has(row.rep))}
        prefetching={Boolean(cachingCueIndexes?.has(row.rep))}
        cachedTitle={cachedTitle}
        prefetchingTitle={prefetchingTitle}
        secondaryText={secondaryTextByRep?.get(row.rep)}
        lazyText={lazyText}
        onRowClick={onRowClick}
        onSeek={onSeek}
        onCharClick={onCharClick}
        onLongPress={onLongPress}
      />,
    );
  }

  return (
    <section className="k-transcript" aria-label={t('player.transcript')}>
      <div className="k-transcript__toolbar">
        <TextField className="k-transcript__search" label={t('transcript.search')} value={query} onValueChange={onQueryChange} leadingIcon="search" />
        {toolbarExtra}
        <IconButton icon="list" label={t('transcript.selectMode')} selected={selectMode} onClick={() => setSelectMode((m) => !m)} />
        <IconButton
          icon="sort"
          label={t('transcript.follow')}
          selected={follow}
          onClick={() => {
            userScrollUntil.current = 0;
            setFollow((f) => !f);
          }}
        />
      </div>
      {selected.size > 0 && (
        <div className="k-transcript__selection" role="toolbar">
          <span>{t('transcript.selected', { count: selected.size })}</span>
          <span className="k-spacer" />
          <Button variant="text" onClick={() => onSelectedChange(new Set())}>
            {t('transcript.clearSelection')}
          </Button>
          <Button variant="filled" icon="sparkle" onClick={() => onExplainSelection(selectedRows)}>
            {t('transcript.explainSelected')}
          </Button>
        </div>
      )}
      <ul ref={listRef} className={cx('k-transcript__list', virtual && 'is-virtual')}>
        {n === 0 && <li className="k-empty">{rows.length === 0 ? t('transcript.empty') : t('transcript.noMatch')}</li>}
        {virtual && range.start > 0 && <li aria-hidden="true" className="k-transcript__spacer" data-testid="transcript-spacer-top" style={{ height: topSpacer }} />}
        {items}
        {virtual && range.end < n && (
          <li aria-hidden="true" className="k-transcript__spacer" data-testid="transcript-spacer-bottom" style={{ height: bottomSpacer }} />
        )}
      </ul>
    </section>
  );
});
