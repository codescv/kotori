/**
 * Transcript (jump panel): merged/de-duplicated `TranscriptRow`s with
 * auto-follow of the playing line, search, click-to-seek (timestamp), per-char
 * click → breakdown, and multi-select (shift-click, select mode, or long-press
 * on touch) → "合并解析" which explains the rows as one sentence via
 * `mergeCuesToSentence`. ASS speakers (`Name`) render as a compact `[Actor]`
 * chip; bilingual fansub cues show the Japanese line (the part sent to Gemini)
 * with the translation as a subtle, tap-to-expand sub-line.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { SubtitleCue, TranscriptRow } from '@kotori/core';
import { RubyText } from '../../../components/breakdown/RubyText';
import { Button } from '../../../components/m3/Button';
import { cx } from '../../../components/m3/cx';
import { IconButton } from '../../../components/m3/IconButton';
import { TextField } from '../../../components/m3/TextField';
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
  readonly prefetchingCueIndexes?: ReadonlySet<number> | undefined;
  /** Whether to prefer scrolling to `explaining` row on mount before playback moves (default `true`). */
  readonly preferExplainingOnMount?: boolean | undefined;
  readonly t: Translate;
}

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
  readonly onRowClick: (row: TranscriptRow, shift: boolean) => void;
  readonly onSeek: (row: TranscriptRow) => void;
  readonly onCharClick: (cue: SubtitleCue, i: number) => void;
  readonly onLongPress: (row: TranscriptRow) => void;
}

const Row = memo(function Row({ row, active, selected, selectMode, highlight, cached, prefetching, cachedTitle, prefetchingTitle, onRowClick, onSeek, onCharClick, onLongPress }: RowProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    longPressed.current = false;
    timer.current = setTimeout(() => {
      longPressed.current = true;
      onLongPress(row);
    }, 500);
  };
  const cancel = (): void => clearTimeout(timer.current);
  const actor = cueActor(row.cue);
  const { primaryJa, secondaryTranslation } = useMemo(() => splitBilingualCueText(row.cue.text), [row.cue.text]);
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  return (
    <li
      className={cx('k-transcript__row', active && 'is-active', selected && 'is-selected', highlight.explaining && 'is-explaining')}
      data-testid="transcript-row"
      data-rep={row.rep}
      aria-selected={selected}
      onPointerDown={onPointerDown}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onClick={(e) => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onRowClick(row, e.shiftKey);
      }}
    >
      <button
        type="button"
        className="k-transcript__time"
        onClick={(e) => {
          e.stopPropagation();
          onSeek(row);
        }}
      >
        {formatClock(row.cue.startMs)}
      </button>
      <div className="k-transcript__body">
        {actor && (
          <span className="k-transcript__actor" title={actor} data-testid="transcript-actor">
            [{actor}]
          </span>
        )}
        <div
          className="k-transcript__text"
          onClick={(e) => {
            // Text clicks open the breakdown unless we are selecting rows.
            if (!selectMode && !e.shiftKey) e.stopPropagation();
          }}
        >
          <RubyText
            text={primaryJa}
            highlight={highlight.span}
            focusIndex={highlight.focus}
            focusSpan={highlight.focusSpan}
            onCharClick={selectMode ? undefined : (i) => onCharClick(row.cue, i)}
          />
        </div>
        {secondaryTranslation && (
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
            {secondaryTranslation}
          </button>
        )}
      </div>
      {!selectMode && cached && (
        <span className="k-transcript__badge k-transcript__badge--cached" title={cachedTitle} data-testid="cue-cached">
          ✦
        </span>
      )}
      {!selectMode && !cached && prefetching && (
        <span className="k-transcript__badge k-transcript__badge--prefetching" title={prefetchingTitle} data-testid="cue-prefetching">
          ◌
        </span>
      )}
      {selectMode && <span className={cx('k-transcript__check', selected && 'is-on')} aria-hidden />}
    </li>
  );
});

export function TranscriptPanel({
  rows,
  activeRawIndexes,
  currentMs,
  selected,
  onSelectedChange,
  onSeek,
  onCharClick,
  onExplainSelection,
  highlightFor,
  cachedCueIndexes,
  prefetchingCueIndexes,
  preferExplainingOnMount = true,
  t,
}: TranscriptPanelProps) {
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const userScrollUntil = useRef(0);
  const isInitialMountRef = useRef(true);
  const initialScrollPendingRef = useRef(true);
  const mountedAtMsRef = useRef(currentMs);
  if (currentMs !== mountedAtMsRef.current) {
    isInitialMountRef.current = false;
  }

  const filtered = useMemo(() => {
    const q = query.trim();
    return q ? rows.filter((r) => r.cue.text.includes(q)) : rows;
  }, [rows, query]);
  const activeIdx = activeRowIndex(filtered, activeRawIndexes, currentMs);
  const targetIdx = scrollTargetRowIndex(filtered, activeIdx, currentMs, highlightFor, preferExplainingOnMount && isInitialMountRef.current);
  const targetRep = filtered[targetIdx]?.rep;

  useEffect(() => {
    if (!follow || targetRep === undefined || Date.now() < userScrollUntil.current) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-rep="${targetRep}"]`);
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const isInitial = initialScrollPendingRef.current;
    initialScrollPendingRef.current = false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (!isInitial || typeof requestAnimationFrame !== 'function') return;
    const raf = requestAnimationFrame(() => {
      const target = listRef.current?.querySelector<HTMLElement>(`[data-rep="${targetRep}"]`);
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [targetRep, follow]);

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
  const selectedRows = rows.filter((r) => selected.has(r.rep));

  return (
    <section className="k-transcript" aria-label={t('player.transcript')}>
      <div className="k-transcript__toolbar">
        <TextField className="k-transcript__search" label={t('transcript.search')} value={query} onValueChange={setQuery} leadingIcon="search" />
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
      <ul
        ref={listRef}
        className="k-transcript__list"
        onWheel={() => (userScrollUntil.current = Date.now() + 3000)}
        onTouchMove={() => (userScrollUntil.current = Date.now() + 3000)}
      >
        {filtered.length === 0 && <li className="k-empty">{rows.length === 0 ? t('transcript.empty') : t('transcript.noMatch')}</li>}
        {filtered.map((row, i) => (
          <Row
            key={row.rep}
            row={row}
            active={i === activeIdx}
            selected={selected.has(row.rep)}
            selectMode={selectMode}
            highlight={highlightFor(row.cue)}
            cached={Boolean(cachedCueIndexes?.has(row.rep))}
            prefetching={Boolean(prefetchingCueIndexes?.has(row.rep))}
            cachedTitle={t('transcript.preExplained')}
            prefetchingTitle={t('transcript.prefetching')}
            onRowClick={onRowClick}
            onSeek={onSeek}
            onCharClick={onCharClick}
            onLongPress={onLongPress}
          />
        ))}
      </ul>
    </section>
  );
}
