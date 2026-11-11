/**
 * Player-level render-count regression (v0.1.43 lag fix): clock ticks must not
 * re-render transcript rows. Before the fix `onSeek` / `onCharClick` changed
 * identity on every video frame, so every memoized `<Row>` re-rendered 24–60×/s.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RubyTextProps } from '../../../components/breakdown/RubyText';
import { DEFAULT_SETTINGS } from '../../../app/default-settings';
import { useSettingsStore } from '../../../stores/settings';
import { renderWithHost, resetStores } from '../../../test/utils';
import { Player } from './Player';

const textRenders = vi.hoisted(() => new Map<string, number>());
vi.mock('../../../components/breakdown/RubyText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../components/breakdown/RubyText')>();
  function CountedRubyText(props: RubyTextProps) {
    if (props['data-testid'] === undefined) textRenders.set(props.text, (textRenders.get(props.text) ?? 0) + 1);
    return createElement(actual.RubyText, props);
  }
  return { ...actual, RubyText: CountedRubyText };
});

describe('Player · clock ticks vs transcript rows', () => {
  beforeEach(() => {
    resetStores();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, seekPaddingMs: 0 } } });
  });

  it('timeupdates inside the current cue update the clock without re-rendering any transcript row', async () => {
    const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    const rows = await screen.findAllByTestId('transcript-row');
    expect(rows.length).toBeGreaterThan(2);
    const video = container.querySelector('video')!;
    let t = 44; // 「え、何の話だっけ？」 plays 43.5–45.5 s; 「昨日のケーキ…」 from 46 s
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => t, set: (v: number) => (t = v) });
    // Settle the initial position, then count.
    act(() => void fireEvent.timeUpdate(video));
    const time = screen.getByTestId('player-time');
    const before = time.textContent;
    const transcriptTexts = new Set(rows.map((r) => r.querySelector('.k-transcript__text')?.textContent ?? ''));
    textRenders.clear();

    for (const sec of [44.05, 44.1, 44.6, 45.2]) {
      t = sec;
      act(() => void fireEvent.timeUpdate(video));
    }
    expect(time.textContent).not.toBe(before);
    const rowRenders = [...textRenders.entries()].filter(([text]) => transcriptTexts.has(text));
    expect(rowRenders).toEqual([]);

    // Crossing into the next cue touches only the two lines whose active state changed.
    t = 46.2;
    act(() => void fireEvent.timeUpdate(video));
    expect([...textRenders.keys()].filter((text) => transcriptTexts.has(text)).sort()).toEqual(['え、何の話だっけ？', '昨日のケーキ、全部食べたでしょ。'].sort());
  });
});
