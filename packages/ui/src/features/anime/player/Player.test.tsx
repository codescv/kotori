import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../app/default-settings';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { glyphAt, renderWithHost, resetStores } from '../../../test/utils';
import { Player } from './Player';

const MERGED = 'ちょっと待ってくれよ、まだ話は終わってないんだから。';

const rowByText = async (text: string): Promise<HTMLElement> => {
  const rows = await screen.findAllByTestId('transcript-row');
  const row = rows.find((r) => r.querySelector('.k-transcript__text')?.textContent === text);
  if (!row) throw new Error(`no row "${text}"`);
  return row;
};

describe('Player · TranscriptPanel · SubtitleOverlay', () => {
  beforeEach(() => {
    resetStores();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, seekPaddingMs: 0 } } });
  });

  it('shows merged karaoke lyrics as one transcript row and hides signs', async () => {
    renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    expect(await rowByText('手を伸ばして')).toBeInTheDocument();
    expect(await rowByText('空へ駆け出そう')).toBeInTheDocument();
    const texts = (await screen.findAllByTestId('transcript-row')).map((r) => r.querySelector('.k-transcript__text')?.textContent ?? '');
    expect(texts.some((tx) => tx.length === 1)).toBe(false);
    expect(texts).not.toContain('第一話');
  });

  it('multi-cue selection → merged explanation; later char clicks map into the merged sentence with no new call', async () => {
    const { host } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    const first = await rowByText('ちょっと待ってくれよ、');
    const second = await rowByText('まだ話は終わってないんだから。');
    fireEvent.click(first, { shiftKey: true });
    fireEvent.click(second, { shiftKey: true });
    expect(screen.getByText('已选 2 句')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '合并解析' }));

    await waitFor(() => expect(useBreakdownStore.getState().status).toBe('ready'));
    const { request, explanation } = useBreakdownStore.getState();
    expect(request?.sentence).toBe(MERGED);
    expect(request?.source).toMatchObject({ kind: 'subtitle', cueCharSpans: [[0, 11], [11, 26]] });
    expect(explanation?.chunks.map((c) => c.surface)).toContain('終わってないんだから');
    expect(host.calls.get('ai.explain')).toBe(1);

    // Clear selection, then click 終 (local index 4) in the second cue.
    fireEvent.click(screen.getByRole('button', { name: '清除选择' }));
    const secondText = second.querySelector<HTMLElement>('.k-transcript__text');
    if (!secondText) throw new Error('no text');
    act(() => {
      fireEvent.click(glyphAt(secondText, 4));
    });
    expect(useBreakdownStore.getState().focusCharIndex).toBe(15);
    expect(host.calls.get('ai.explain')).toBe(1);
    // Reverse highlight: the focused chunk (終わってないんだから = sentence [15,25)) lights up in the row.
    expect(glyphAt(secondText, 4)).toHaveClass('is-hl', 'is-focus');
    expect(glyphAt(secondText, 13)).toHaveClass('is-hl');
    expect(glyphAt(secondText, 3)).not.toHaveClass('is-hl');
    expect(glyphAt(secondText, 14)).not.toHaveClass('is-hl');
    expect(second).toHaveClass('is-explaining');
    expect(first).toHaveClass('is-explaining');
  });

  it('overlay char click explains the on-screen cue and ← / → jump between lines', async () => {
    renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    // Episode 1 resumes at 45 s → 「え、何の話だっけ？」 is on screen.
    const cue = await screen.findByTestId('overlay-cue');
    expect(cue.textContent).toBe('え、何の話だっけ？');
    fireEvent.click(glyphAt(cue, 2));
    await waitFor(() => expect(useBreakdownStore.getState().status).toBe('ready'));
    expect(useBreakdownStore.getState().request?.sentence).toBe('え、何の話だっけ？');
    expect(useBreakdownStore.getState().focusCharIndex).toBe(2);
    // Compact layout → breakdown in a bottom sheet.
    const sheet = screen.getByRole('dialog', { name: 'AI 句子解析' });
    expect(within(sheet).getByTestId('ai-breakdown-panel')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useBreakdownStore.getState().isOpen).toBe(false);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('overlay-cue').textContent).toBe('昨日のケーキ、全部食べたでしょ。'));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByTestId('overlay-cue').textContent).toBe('え、何の話だっけ？'));
  });

  it('B toggles blind-listening blur', async () => {
    const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    await screen.findByTestId('overlay-cue');
    const overlay = container.querySelector('.k-sub-overlay');
    expect(overlay).not.toHaveClass('is-blind');
    fireEvent.keyDown(window, { key: 'b' });
    expect(overlay).toHaveClass('is-blind');
  });

  it('pre-explain toggle syncs globally and batch-prefetches up to 5 upcoming subtitle lines', async () => {
    const { host } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    await screen.findByTestId('overlay-cue');
    const toggle = screen.getByTestId('pre-explain-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    await waitFor(async () => {
      expect(useSettingsStore.getState().settings.anime.autoPreExplain).toBe(true);
      expect((await host.settings.get()).anime.autoPreExplain).toBe(true);
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      expect(host.calls.get('ai.explainBatch')).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId('cue-cached').length).toBeGreaterThanOrEqual(1);
    });
  });
});
