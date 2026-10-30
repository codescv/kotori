import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubtitleCue, TranscriptRow } from '@kotori/core';
import { createTranslator } from '../../../i18n';
import type { CueHighlight } from './useSubtitleBreakdown';
import { activeRowIndex, scrollTargetRowIndex, TranscriptPanel } from './TranscriptPanel';

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
