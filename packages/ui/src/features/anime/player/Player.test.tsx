import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../app/default-settings';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { useSnackbarStore } from '../../../stores/snackbar';
import { glyphAt, renderWithHost, resetStores } from '../../../test/utils';
import { formatRate, Player } from './Player';

const playerCss = readFileSync(resolve(import.meta.dirname, './player.css'), 'utf8');

/** Emulate a viewport for `matchMedia` (min/max width/height + orientation). */
function setViewport(width: number, height: number): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const checks: boolean[] = [];
    for (const [, kind, px] of query.matchAll(/(min-width|max-width|min-height|max-height):\s*(\d+)px/g)) {
      const n = Number(px);
      checks.push(kind === 'min-width' ? width >= n : kind === 'max-width' ? width <= n : kind === 'min-height' ? height >= n : height <= n);
    }
    const orient = /orientation:\s*(landscape|portrait)/.exec(query);
    if (orient) checks.push(orient[1] === 'landscape' ? width >= height : height > width);
    const matches = checks.length > 0 && checks.every(Boolean) && !/pointer:\s*coarse|hover:\s*none/.test(query);
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    // Reverse highlight: the focused chunk (終わってないんだから = sentence [15,25)) lights up in the row,
    // and all glyphs of the focused word 終わっ ([4, 7) locally) get .is-focus.
    expect(glyphAt(secondText, 4)).toHaveClass('is-hl', 'is-focus', 'is-focus-start');
    expect(glyphAt(secondText, 5)).toHaveClass('is-hl', 'is-focus');
    expect(glyphAt(secondText, 6)).toHaveClass('is-hl', 'is-focus', 'is-focus-end');
    expect(glyphAt(secondText, 7)).not.toHaveClass('is-focus');
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

  it('B / button hides the video subtitles entirely (no blur) and shows an indicator', async () => {
    const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    await screen.findByTestId('overlay-cue');
    const toggle = screen.getByTestId('blind-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('.k-sub-overlay')).not.toHaveClass('is-blind');
    fireEvent.keyDown(window, { key: 'b' });
    expect(container.querySelector('.k-sub-overlay')).toHaveClass('is-blind');
    expect(screen.queryByTestId('overlay-cue')).toBeNull();
    expect(screen.getByTestId('subs-hidden-badge')).toHaveTextContent('已隐藏视频字幕');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(useSnackbarStore.getState().queue.at(-1)?.text).toBe('已隐藏视频字幕');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('overlay-cue')).toBeInTheDocument();
    expect(screen.queryByTestId('subs-hidden-badge')).toBeNull();
    expect(useSnackbarStore.getState().queue.at(-1)?.text).toBe('已显示视频字幕');
  });

  it('speed button shows the current playback rate', async () => {
    renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    await screen.findByTestId('overlay-cue');
    const speed = screen.getByTestId('speed-button');
    expect(speed).toHaveTextContent('1×');
    fireEvent.click(speed);
    fireEvent.click(screen.getByText('0.75×'));
    expect(screen.getByTestId('speed-button')).toHaveTextContent('0.75×');
    expect(formatRate(1.25)).toBe('1.25×');
  });

  it('transcript rows show the ASS speaker chip; context lines carry [Actor] and the target speaker', async () => {
    renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    const row = await rowByText('え、何の話だっけ？');
    expect(within(row).getByTestId('transcript-actor')).toHaveTextContent('[ことり]');
    const cue = await screen.findByTestId('overlay-cue');
    fireEvent.click(glyphAt(cue, 2));
    await waitFor(() => expect(useBreakdownStore.getState().status).toBe('ready'));
    const req = useBreakdownStore.getState().request;
    expect(req?.contextBefore?.at(-1)).toBe('[湊] まだ話は終わってないんだから。');
    expect(req?.contextAfter?.[0]).toBe('[湊] 昨日のケーキ、全部食べたでしょ。');
  });

  it('transcript char click pauses playback (pauseOnTranscriptClick, default on)', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    const row = await rowByText('昨日のケーキ、全部食べたでしょ。');
    const text = row.querySelector<HTMLElement>('.k-transcript__text');
    if (!text) throw new Error('no text');
    pause.mockClear();
    fireEvent.click(glyphAt(text, 0));
    expect(pause).toHaveBeenCalled();
    pause.mockRestore();
  });

  it('transcript char click keeps playing when pauseOnTranscriptClick is off', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, seekPaddingMs: 0, pauseOnTranscriptClick: false } } });
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    const row = await rowByText('昨日のケーキ、全部食べたでしょ。');
    const text = row.querySelector<HTMLElement>('.k-transcript__text');
    if (!text) throw new Error('no text');
    pause.mockClear();
    fireEvent.click(glyphAt(text, 0));
    expect(pause).not.toHaveBeenCalled();
    pause.mockRestore();
  });

  it('single tap toggles play after 240 ms; a double-tap never toggles play/pause', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
    await screen.findByTestId('overlay-cue');
    const video = container.querySelector('video');
    if (!video) throw new Error('no video');
    play.mockClear();
    pause.mockClear();
    fireEvent.click(video, { detail: 1 });
    expect(play).not.toHaveBeenCalled(); // deferred
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    play.mockClear();
    // Double-tap: the deferred single-tap toggle is cancelled, play state untouched.
    fireEvent.click(video, { detail: 1 });
    fireEvent.click(video, { detail: 2 });
    fireEvent.doubleClick(video, { detail: 2 });
    await sleep(350);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    play.mockRestore();
    pause.mockRestore();
  });

  it('centre double-tap requests fullscreen on the whole player (sheet stays visible)', async () => {
    const calls: Element[] = [];
    const original = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = function (this: HTMLElement) {
      calls.push(this);
      return Promise.resolve();
    };
    try {
      const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      await screen.findByTestId('overlay-cue');
      const stage = container.querySelector<HTMLElement>('.k-player__stage');
      if (!stage) throw new Error('no stage');
      fireEvent.doubleClick(stage);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe(screen.getByTestId('player'));
    } finally {
      HTMLElement.prototype.requestFullscreen = original;
    }
  });

  describe('expanded layout', () => {
    beforeEach(() => setViewport(1280, 800));
    afterEach(() => vi.unstubAllGlobals());

    it('合并解析 from the transcript tab while the AI tab was already used switches back to the AI tab', async () => {
      const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      const cue = await screen.findByTestId('overlay-cue');
      expect(container.querySelector('.k-player__hint')).toBeNull();
      expect(screen.getByRole('button', { name: '播放' })).toHaveAttribute('title', '播放 (Space)');
      expect(screen.getByRole('button', { name: '上一句 (←)' })).toHaveAttribute('title', '上一句 (←)');
      expect(screen.getByRole('button', { name: '下一句 (→)' })).toHaveAttribute('title', '下一句 (→)');
      expect(screen.getByTestId('blind-toggle')).toHaveAttribute('title', '隐藏字幕 (B)');
      fireEvent.click(glyphAt(cue, 2));
      await waitFor(() => expect(useBreakdownStore.getState().status).toBe('ready'));
      expect(screen.getByRole('tab', { name: /AI 解析/ })).toHaveAttribute('aria-selected', 'true');
      // Back to the transcript tab with the breakdown still open.
      fireEvent.click(screen.getByRole('tab', { name: /字幕列表/ }));
      expect(useBreakdownStore.getState().isOpen).toBe(true);
      fireEvent.click(await rowByText('ちょっと待ってくれよ、'), { shiftKey: true });
      fireEvent.click(await rowByText('まだ話は終わってないんだから。'), { shiftKey: true });
      fireEvent.click(screen.getByRole('button', { name: '合并解析' }));
      await waitFor(() => expect(screen.getByRole('tab', { name: /AI 解析/ })).toHaveAttribute('aria-selected', 'true'));
      await waitFor(() => expect(useBreakdownStore.getState().request?.sentence).toBe(MERGED));
    });

    it('switching from AI解析 back to 字幕列表 scrolls to the current or explained subtitle row', async () => {
      const scrolled: Array<{ text: string | undefined; opts: unknown }> = [];
      const originalScroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
        if (this.getAttribute('data-testid') === 'transcript-row') {
          scrolled.push({ text: this.querySelector('.k-transcript__text')?.textContent ?? undefined, opts });
        }
      };

      try {
        // 1. Active cue at saved position (45s -> 「え、何の話だっけ？」)
        const { unmount } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        const cue = await screen.findByTestId('overlay-cue');
        expect(cue.textContent).toBe('え、何の話だっけ？');
        fireEvent.click(glyphAt(cue, 0));
        await waitFor(() => expect(screen.getByRole('tab', { name: /AI 解析/ })).toHaveAttribute('aria-selected', 'true'));

        scrolled.length = 0;
        fireEvent.click(screen.getByRole('tab', { name: /字幕列表/ }));
        await waitFor(() =>
          expect(scrolled).toContainEqual({
            text: 'え、何の話だっけ？',
            opts: { block: 'center', behavior: 'smooth' },
          }),
        );
        unmount();

        // 2. Episode at 00:00 (activeRowIndex = -1): clicking a far-down transcript line opens AI解析,
        //    and switching back to 字幕列表 scrolls to that explained row instead of staying at top.
        resetStores();
        useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, seekPaddingMs: 250 } } });
        renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep2" />);
        const farRow = await rowByText('人生を賭けた勝負だって、わかってる。');
        const farText = farRow.querySelector<HTMLElement>('.k-transcript__text');
        if (!farText) throw new Error('no text');
        fireEvent.click(glyphAt(farText, 0));
        await waitFor(() => expect(screen.getByRole('tab', { name: /AI 解析/ })).toHaveAttribute('aria-selected', 'true'));

        scrolled.length = 0;
        fireEvent.click(screen.getByRole('tab', { name: /字幕列表/ }));
        await waitFor(() =>
          expect(scrolled).toContainEqual({
            text: '人生を賭けた勝負だって、わかってる。',
            opts: { block: 'center', behavior: 'smooth' },
          }),
        );

        // 3. Seeking with seekPaddingMs = 250 (ms = startMs - 250 -> activeRowIndex = -1 between cues),
        //    switching to AI解析 and back to 字幕列表 scrolls to the seeked row.
        const seekTarget = await rowByText('空がこんなに青いと、なんでもできる気がする。');
        const timeBtn = seekTarget.querySelector<HTMLButtonElement>('.k-transcript__time');
        if (!timeBtn) throw new Error('no time button');
        fireEvent.click(timeBtn);
        fireEvent.click(screen.getByRole('tab', { name: /AI 解析/ }));
        await waitFor(() => expect(screen.getByRole('tab', { name: /AI 解析/ })).toHaveAttribute('aria-selected', 'true'));

        scrolled.length = 0;
        fireEvent.click(screen.getByRole('tab', { name: /字幕列表/ }));
        await waitFor(() =>
          expect(scrolled).toContainEqual({
            text: '空がこんなに青いと、なんでもできる気がする。',
            opts: { block: 'center', behavior: 'smooth' },
          }),
        );
      } finally {
        Element.prototype.scrollIntoView = originalScroll;
      }
    });
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

  it('keeps player-time non-wrapping and non-shrinking in compact mobile controls', async () => {
    expect(playerCss).toMatch(/\.k-player__time\s*\{[^}]*white-space:\s*nowrap;[^}]*flex-shrink:\s*0;/s);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-player__controls\s*\{[^}]*padding:\s*4px\s+6px\s+0;/s);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-player__buttons\s*\{[^}]*gap:\s*1px;[^}]*flex-wrap:\s*nowrap;/s);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-player__buttons\s+\.k-icon-btn\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/s);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-player__time\s*\{[^}]*white-space:\s*nowrap;[^}]*flex-shrink:\s*0;/s);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-player__speed-btn\s*\{[^}]*height:\s*30px;[^}]*min-width:\s*38px;[^}]*flex-shrink:\s*0;/s);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-repeat\s*\{[^}]*flex-shrink:\s*0;[^}]*gap:\s*0;/s);

    setViewport(360, 800);
    try {
      const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      await screen.findByTestId('overlay-cue');
      expect(screen.getByTestId('player')).toHaveClass('k-player--compact');

      const timeEl = screen.getByTestId('player-time');
      expect(timeEl).toHaveClass('k-player__time');
      expect(timeEl).toHaveTextContent('0:45 / 23:40');

      // Activate single-cue repeat (`R`) and ensure repeat counter + controls render inside compact bar.
      fireEvent.keyDown(window, { key: 'r' });
      expect(screen.getByTestId('repeat-count')).toBeInTheDocument();
      expect(container.querySelector('.k-player__buttons .k-repeat')).not.toBeNull();
      expect(screen.getByTestId('speed-button')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
