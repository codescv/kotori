import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubtitleCue, TranscriptRow } from '@kotori/core';
import type { RubyTextProps } from '../../../components/breakdown/RubyText';
import { createTranslator } from '../../../i18n';
import type { CueHighlight } from './useSubtitleBreakdown';
import { activeRowIndex, rowOffsets, scrollTargetRowIndex, TranscriptPanel, visibleRowRange } from './TranscriptPanel';

// Counts renders of each transcript row's text (a non-memo wrapper re-renders exactly when its `<Row>` does).
const textRenders = vi.hoisted(() => new Map<string, number>());
vi.mock('../../../components/breakdown/RubyText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../components/breakdown/RubyText')>();
  function CountedRubyText(props: RubyTextProps) {
    textRenders.set(props.text, (textRenders.get(props.text) ?? 0) + 1);
    return createElement(actual.RubyText, props);
  }
  return { ...actual, RubyText: CountedRubyText };
});

const t = createTranslator('zh-CN');

const NO_HL: CueHighlight = { span: undefined, focus: undefined, focusSpan: undefined, explaining: false };

function makeRow(index: number, startMs: number, endMs: number, text: string): TranscriptRow {
  const cue: SubtitleCue = { index, startMs, endMs, text, rawText: text };
  return { rep: index, cue, rawIndexes: [index], chainEndMs: endMs };
}

const SAMPLE_ROWS: readonly TranscriptRow[] = [
  makeRow(0, 10_000, 12_500, 'おはよう、ことり。'),
  makeRow(1, 15_000, 17_500, 'うん、朝の空気が好きなんだ。'),
  makeRow(2, 22_000, 24_500, '昨日のケーキ、全部食べたでしょ。'),
  makeRow(3, 30_000, 33_000, '人生を賭けた勝負だって、わかってる。'),
];

describe('TranscriptPanel · scrollTargetRowIndex', () => {
  afterEach(() => vi.restoreAllMocks());

  it('picks activeIdx when playing a cue and no different cue is being explained', () => {
    const active = activeRowIndex(SAMPLE_ROWS, new Set([1]), 16_000);
    expect(active).toBe(1);
    expect(scrollTargetRowIndex(SAMPLE_ROWS, active, 16_000, () => NO_HL, true)).toBe(1);
  });

  it('prefers explainingIdx on tab return even when video is at 00:00 or paused on an earlier cue', () => {
    const hlFor = (cue: SubtitleCue): CueHighlight => (cue.index === 3 ? { ...NO_HL, explaining: true } : NO_HL);
    // Video at 00:00 (activeIdx = -1)
    expect(scrollTargetRowIndex(SAMPLE_ROWS, -1, 0, hlFor, true)).toBe(3);
    expect(scrollTargetRowIndex(SAMPLE_ROWS, -1, 0, hlFor, false)).toBe(3);
    // Video paused at row 0 (11s) while user clicked row 3 to explain
    expect(scrollTargetRowIndex(SAMPLE_ROWS, 0, 11_000, hlFor, true)).toBe(3);
    // Once playback advances (preferExplaining = false), follows activeIdx and stays near ms across gaps
    expect(scrollTargetRowIndex(SAMPLE_ROWS, 2, 23_000, hlFor, false)).toBe(2);
    expect(scrollTargetRowIndex(SAMPLE_ROWS, -1, 25_000, hlFor, false)).toBe(2);
  });

  it('resolves pre-roll seek padding (startMs - 250ms) and inter-cue pause gaps when activeIdx is -1', () => {
    // At 00:00 before any cue or seek: -1 (top of list)
    expect(scrollTargetRowIndex(SAMPLE_ROWS, -1, 0, () => NO_HL, true)).toBe(-1);
    // Right after jumpToRow(row 2) with seekPaddingMs = 250 -> ms = 21_750 (250ms before 22_000)
    expect(activeRowIndex(SAMPLE_ROWS, new Set(), 21_750)).toBe(-1);
    expect(scrollTargetRowIndex(SAMPLE_ROWS, -1, 21_750, () => NO_HL, true)).toBe(2);
    // Paused in silent gap at 19_000ms (after row 1 ended at 17_500ms, 3000ms before row 2)
    expect(scrollTargetRowIndex(SAMPLE_ROWS, -1, 19_000, () => NO_HL, true)).toBe(1);
  });

  it('scrolls target row on mount and immediately re-scrolls when follow is toggled back on after wheel scroll', () => {
    const scrolled: Array<{ rep: string | null; opts: unknown }> = [];
    const originalScroll = Element.prototype.scrollIntoView;
    const rafCallbacks: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
      scrolled.push({ rep: this.getAttribute('data-rep'), opts });
    };

    try {
      render(
        <TranscriptPanel
          rows={SAMPLE_ROWS}
          activeRawIndexes={new Set()}
          currentMs={19_000}
          selected={new Set()}
          onSelectedChange={() => {}}
          onSeek={() => {}}
          onCharClick={() => {}}
          onExplainSelection={() => {}}
          highlightFor={() => NO_HL}
          t={t}
        />,
      );

      // Paused in gap at 19s -> scrolls to row 1 (rep="1") on mount + rAF settle
      expect(scrolled).toContainEqual({ rep: '1', opts: { block: 'center', behavior: 'smooth' } });
      for (const cb of rafCallbacks.splice(0)) cb(16);
      expect(scrolled).toContainEqual({ rep: '1', opts: { block: 'center' } });

      // Simulate manual wheel scroll (sets userScrollUntil) then toggle follow off and back on
      const list = screen.getByRole('list');
      fireEvent.wheel(list);
      scrolled.length = 0;

      const followBtn = screen.getByRole('button', { name: t('transcript.follow') });
      fireEvent.click(followBtn); // off
      expect(scrolled).toHaveLength(0);
      fireEvent.click(followBtn); // on -> resets userScrollUntil and scrolls immediately
      expect(scrolled).toContainEqual({ rep: '1', opts: { block: 'center', behavior: 'smooth' } });
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      rafSpy.mockRestore();
    }
  });

  it('uses secondaryTextByRep as fallback translation while preserving inline secondaryTranslation precedence', () => {
    const rows: readonly TranscriptRow[] = [
      makeRow(0, 1000, 3000, 'おはよう、ことり。'),
      makeRow(1, 4000, 6000, 'うん、朝の空気が好きなんだ。\n嗯，我喜欢早晨的空气（内嵌）'),
      makeRow(2, 7000, 9000, '昨日のケーキ、全部食べたでしょ。'),
    ];
    const secondaryTextByRep = new Map<number, string>([
      [0, '早啊，小鸟（外挂副字幕）'],
      [1, '嗯，我喜欢早晨的空气（外挂副字幕）'],
    ]);

    render(
      <TranscriptPanel
        rows={rows}
        activeRawIndexes={new Set()}
        currentMs={0}
        selected={new Set()}
        onSelectedChange={() => {}}
        onSeek={() => {}}
        onCharClick={() => {}}
        onExplainSelection={() => {}}
        highlightFor={() => NO_HL}
        secondaryTextByRep={secondaryTextByRep}
        t={t}
      />,
    );

    const renderedRows = screen.getAllByTestId('transcript-row');
    expect(renderedRows[0]?.querySelector('[data-testid="transcript-secondary"]')?.textContent).toBe('早啊，小鸟（外挂副字幕）');
    // Inline bilingual translation takes precedence over secondaryTextByRep
    expect(renderedRows[1]?.querySelector('[data-testid="transcript-secondary"]')?.textContent).toBe('嗯，我喜欢早晨的空气（内嵌）');
    // Row with neither inline translation nor secondaryTextByRep has no secondary button
    expect(renderedRows[2]?.querySelector('[data-testid="transcript-secondary"]')).toBeNull();
  });
});

describe('TranscriptPanel · performance (long transcripts)', () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  afterEach(() => {
    vi.restoreAllMocks();
    Element.prototype.scrollIntoView = originalScrollIntoView;
    textRenders.clear();
  });

  const ROW_TEXT = (i: number): string => `第${i}行のセリフ、ことりと一緒に。`;
  const longRows = (n: number): readonly TranscriptRow[] => Array.from({ length: n }, (_, i) => makeRow(i, i * 3000 + 1000, i * 3000 + 2500, ROW_TEXT(i)));
  const noHl = (): CueHighlight => NO_HL;
  const noop = (): void => {};
  const EMPTY = new Set<number>();

  function renderPanel(rows: readonly TranscriptRow[], currentMs: number, active: ReadonlySet<number>, onCharClick: (cue: SubtitleCue, i: number) => void = noop) {
    const props = {
      rows,
      selected: EMPTY,
      onSelectedChange: noop,
      onSeek: noop,
      onCharClick,
      onExplainSelection: noop,
      highlightFor: noHl,
      t,
    };
    const view = render(<TranscriptPanel {...props} activeRawIndexes={active} currentMs={currentMs} />);
    return {
      ...view,
      tick: (ms: number, nextActive: ReadonlySet<number>) => view.rerender(<TranscriptPanel {...props} activeRawIndexes={nextActive} currentMs={ms} />),
    };
  }

  function stubScroll(): Array<string | null> {
    const scrolled: Array<string | null> = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-rep'));
    };
    return scrolled;
  }

  it('clock ticks inside the same cue re-render no rows; a cue change re-renders only the old and new active rows', () => {
    stubScroll();
    for (const n of [4, 500]) {
      const rows = n === 4 ? SAMPLE_ROWS : longRows(n);
      const r0 = rows[0]!;
      const r1 = rows[1]!;
      const in0 = new Set([r0.rep]);
      const in1 = new Set([r1.rep]);
      const view = renderPanel(rows, r0.cue.startMs, in0);
      textRenders.clear();
      for (const dt of [50, 100, 500, 1000]) view.tick(r0.cue.startMs + dt, in0);
      expect([...textRenders.values()].reduce((a, b) => a + b, 0)).toBe(0);

      view.tick(r1.cue.startMs + 10, in1);
      expect([...textRenders.keys()].sort()).toEqual([r0.cue.text, r1.cue.text].sort());
      expect(textRenders.get(r0.cue.text)).toBe(1);
      expect(textRenders.get(r1.cue.text)).toBe(1);
      view.unmount();
      textRenders.clear();
    }
  });

  it('500 rows: windowed DOM, plain-text inactive rows, clickable lazy text, auto-scroll mounts a far target', () => {
    const scrolled = stubScroll();
    const rows = longRows(500);
    const onCharClick = vi.fn();
    const view = renderPanel(rows, rows[5]!.cue.startMs + 10, new Set([5]), onCharClick);
    const { container } = view;

    const mounted = (): HTMLElement[] => screen.getAllByTestId('transcript-row');
    expect(mounted().length).toBeLessThanOrEqual(120);
    expect(mounted().length).toBeGreaterThan(10);
    expect(screen.getByTestId('transcript-spacer-bottom')).toBeInTheDocument();
    // Only the active row is split into per-character glyph spans.
    const activeRow = container.querySelector<HTMLElement>('[data-rep="5"]')!;
    expect(activeRow).toHaveClass('is-active');
    expect(container.querySelectorAll('[data-glyph]').length).toBe(activeRow.querySelectorAll('[data-glyph]').length);
    expect(activeRow.querySelectorAll('[data-glyph]').length).toBe(ROW_TEXT(5).length);
    const lazyRow = container.querySelector<HTMLElement>('[data-rep="7"]')!;
    expect(lazyRow.querySelectorAll('[data-glyph]')).toHaveLength(0);
    expect(lazyRow.querySelector('.k-transcript__text')?.textContent).toBe(ROW_TEXT(7));

    // Clicking plain text still opens the breakdown (no caret API in jsdom → segment start).
    fireEvent.click(lazyRow.querySelector('.k-seg')!);
    expect(onCharClick).toHaveBeenLastCalledWith(rows[7]!.cue, 0);
    // With a caret API the exact character inside the text node is reported.
    const textNode = lazyRow.querySelector('.k-seg')!.firstChild!;
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const range = document.createRange();
        range.setStart(textNode, 3);
        return range;
      },
    });
    try {
      fireEvent.click(lazyRow.querySelector('.k-seg')!, { clientX: 40, clientY: 10 });
      expect(onCharClick).toHaveBeenLastCalledWith(rows[7]!.cue, 3);
    } finally {
      Reflect.deleteProperty(document, 'caretRangeFromPoint');
    }

    // Playback jumps to row #350: it is mounted (window moved) and scrolled into view.
    scrolled.length = 0;
    act(() => view.tick(rows[350]!.cue.startMs + 10, new Set([350])));
    expect(container.querySelector('[data-rep="350"]')).toHaveClass('is-active');
    expect(scrolled).toContain('350');
    expect(mounted().length).toBeLessThanOrEqual(120);
    expect(container.querySelector('[data-rep="5"]')).toBeNull();
    expect(screen.getByTestId('transcript-spacer-top')).toBeInTheDocument();
  });

  it('small transcripts render every row with per-character glyphs (no windowing)', () => {
    stubScroll();
    const rows = longRows(50);
    const { container } = renderPanel(rows, 0, EMPTY);
    expect(screen.getAllByTestId('transcript-row')).toHaveLength(50);
    expect(container.querySelector('.k-transcript__spacer')).toBeNull();
    expect(container.querySelector('[data-rep="49"] [data-glyph]')).not.toBeNull();
  });

  it('rowOffsets / visibleRowRange map the viewport to row indexes using measured heights', () => {
    const rows = longRows(10);
    const offs = rowOffsets(rows, new Map([[0, 100]]));
    expect(offs[0]).toBe(0);
    expect(offs[1]).toBe(100);
    expect(offs[2]).toBe(154);
    expect(visibleRowRange(offs, 0, 120)).toEqual([0, 2]);
    expect(visibleRowRange(offs, 160, 54)).toEqual([2, 4]);
    expect(visibleRowRange(offs, 10_000, 100)).toEqual([9, 10]);
  });
});

