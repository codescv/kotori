import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedSubtitleTrack, SubtitleCue } from '@kotori/core';
import { DEFAULT_SETTINGS } from '../../../app/default-settings';
import { dispatchBackNavigation, useRouteStore } from '../../../app/routes';
import { HostProvider } from '../../../host/HostContext';
import { createMockPlatformHost } from '../../../host/mock-host';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { useSnackbarStore } from '../../../stores/snackbar';
import { glyphAt, renderWithHost, resetStores } from '../../../test/utils';
import { formatRate, Player } from './Player';
import { SubtitleOverlay } from './SubtitleOverlay';

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
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-player__speed-btn\s*\{[^}]*height:\s*30px;[^}]*min-width:\s*32px;[^}]*flex-shrink:\s*0;/s);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-player__speed-btn\s+\.k-icon\s*\{[^}]*display:\s*none;/s);
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
      expect(screen.getByTestId('fullscreen-toggle')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('immersive landscape & fullscreen UX', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('enters .k-player--immersive automatically in mobile landscape (915×412 and 800×360) with drawer closed by default', async () => {
      // Ensure HUD center buttons beat `.k-icon-btn` specificity when `styles.css` loads after `player.css`,
      // and `.k-side-sheet .k-sheet__body` avoids 0px-width scrollIntoView overshoot during open transition.
      expect(playerCss).toMatch(/\.k-hud\s+\.k-hud__center-btn\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px;/s);
      expect(playerCss).toMatch(/\.k-hud\s+\.k-hud__center-btn:not\(\.k-icon-btn--filled\)\s*\{[^}]*background:\s*rgb\(0 0 0 \/ 0\.48\);[^}]*color:\s*#fff;/s);
      expect(playerCss).toMatch(/\.k-hud\s+\.k-hud__play-btn\s*\{[^}]*width:\s*64px;[^}]*height:\s*64px;/s);
      expect(playerCss).toMatch(/\.k-player--immersive\s+\.k-side-sheet\s+\.k-sheet__body\s*\{[^}]*min-width:\s*298px;/s);
      expect(playerCss).toMatch(/\.k-player--immersive\s+\.k-side-sheet\s+\.k-breakdown\s*>\s*\.k-breakdown__sentence\s*\{[^}]*position:\s*static;/s);

      for (const [vw, vh] of [
        [915, 412],
        [800, 360],
      ] as const) {
        setViewport(vw, vh);
        const { container, unmount } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        await screen.findByTestId('overlay-cue');

        const player = screen.getByTestId('player');
        expect(player).toHaveClass('k-player--immersive');
        expect(player).not.toHaveClass('k-player--compact', 'k-player--expanded', 'is-drawer-open');
        expect(container.querySelector('.k-player__header')).toBeNull();
        expect(container.querySelector('.k-player__controls')).toBeNull();
        expect(container.querySelector('.k-player__compact-transcript')).toBeNull();
        expect(container.querySelector('.k-player__notice')).toBeNull();

        const drawer = container.querySelector('aside.k-side-sheet');
        expect(drawer).not.toBeNull();
        expect(drawer).not.toHaveClass('is-open');
        expect(drawer).toHaveAttribute('aria-hidden', 'true');

        const hud = screen.getByTestId('player-hud');
        expect(hud).toHaveAttribute('data-visible', 'true');
        expect(hud).toHaveAttribute('aria-hidden', 'false');
        expect(within(hud).getByTestId('immersive-drawer-toggle')).toHaveAttribute('aria-pressed', 'false');
        expect(within(hud).getByTestId('fullscreen-toggle')).toBeInTheDocument();

        // HUD precedes SubtitleOverlay inside .k-player__stage so `.k-hud[data-visible="true"] ~ .k-sub-overlay` lifts subtitles.
        const stage = container.querySelector('.k-player__stage');
        const overlay = container.querySelector('.k-sub-overlay');
        expect(stage?.contains(hud)).toBe(true);
        expect(stage?.contains(overlay)).toBe(true);
        expect(Boolean(hud.compareDocumentPosition(overlay!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

        unmount();
      }
    });

    it('single-tap on video toggles HUD after 240 ms, auto-hides after 3500 ms when playing, stays pinned when paused, and ignores touch pointermove', async () => {
      setViewport(915, 412);
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      });
      try {
        const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        await screen.findByTestId('overlay-cue');

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const hud = screen.getByTestId('player-hud');
        const video = container.querySelector('video')!;
        const stage = container.querySelector<HTMLElement>('.k-player__stage')!;

        // Paused with drawer closed: HUD stays pinned past 3500 ms.
        act(() => {
          vi.advanceTimersByTime(5000);
        });
        expect(hud).toHaveAttribute('data-visible', 'true');

        // Explicit single-tap hides HUD after 240 ms without toggling playback.
        play.mockClear();
        fireEvent.click(video, { detail: 1 });
        act(() => {
          vi.advanceTimersByTime(150);
        });
        expect(hud).toHaveAttribute('data-visible', 'true');
        act(() => {
          vi.advanceTimersByTime(100);
        });
        expect(hud).toHaveAttribute('data-visible', 'false');
        expect(play).not.toHaveBeenCalled();

        // Touch pointermove must NEVER wake the HUD; mouse pointermove (>= 2px) wakes it.
        const makePointerMove = (pointerType: string, movementX: number, movementY: number): Event => {
          const ev = new MouseEvent('pointermove', { bubbles: true });
          Object.defineProperties(ev, {
            pointerType: { value: pointerType },
            movementX: { value: movementX },
            movementY: { value: movementY },
          });
          return ev;
        };
        fireEvent(stage, makePointerMove('touch', 12, 8));
        expect(hud).toHaveAttribute('data-visible', 'false');
        fireEvent(stage, makePointerMove('mouse', 6, 0));
        expect(hud).toHaveAttribute('data-visible', 'true');

        // Clicking <video> right after mouse wake (< 350 ms) keeps HUD visible instead of re-hiding it,
        // while a subsequent click when HUD is already visible hides it cleanly.
        fireEvent.click(video, { detail: 1 });
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(hud).toHaveAttribute('data-visible', 'true');
        fireEvent.click(video, { detail: 1 });
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(hud).toHaveAttribute('data-visible', 'false');
        fireEvent.click(video, { detail: 1 });
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(hud).toHaveAttribute('data-visible', 'true');

        // Start playing -> HUD auto-hides after 3500 ms (unless a menu is open).
        fireEvent.click(within(hud).getByRole('button', { name: '播放' }));
        expect(within(hud).getByRole('button', { name: '暂停' })).toBeInTheDocument();
        act(() => {
          vi.advanceTimersByTime(3400);
        });
        expect(hud).toHaveAttribute('data-visible', 'true');
        act(() => {
          vi.advanceTimersByTime(200);
        });
        expect(hud).toHaveAttribute('data-visible', 'false');

        // Wake HUD via single-tap, open speed menu -> auto-hide pauses while menu is open.
        fireEvent.click(video, { detail: 1 });
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(hud).toHaveAttribute('data-visible', 'true');
        fireEvent.click(within(hud).getByTestId('speed-button'));
        expect(within(hud).getByRole('menu')).toBeInTheDocument();
        act(() => {
          vi.advanceTimersByTime(4500);
        });
        expect(hud).toHaveAttribute('data-visible', 'true');
      } finally {
        play.mockRestore();
      }
    });

    it('centre double-tap in immersive toggles play/pause without exiting fullscreen or flashing HUD', async () => {
      setViewport(360, 800);
      const setImmersive = vi.fn().mockResolvedValue(undefined);
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      });
      const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event('pause'));
      });
      try {
        const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />, {
          screen: { setImmersive },
        });
        await screen.findByTestId('overlay-cue');

        fireEvent.click(screen.getByTestId('fullscreen-toggle'));
        expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const video = container.querySelector('video')!;
        const stage = container.querySelector<HTMLElement>('.k-player__stage')!;
        const hud = screen.getByTestId('player-hud');

        // Hide HUD via single tap first so we can verify double-tap does not flash it.
        fireEvent.click(video, { detail: 1 });
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(hud).toHaveAttribute('data-visible', 'false');

        play.mockClear();
        pause.mockClear();
        vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: 800,
          height: 360,
          right: 800,
          bottom: 360,
          toJSON: () => ({}),
        });

        // Double-tap centre (x = 400 -> relX = 0.5): cancels single-tap HUD toggle, toggles play!
        fireEvent.click(video, { detail: 1, clientX: 400, clientY: 180 });
        fireEvent.click(video, { detail: 2, clientX: 400, clientY: 180 });
        fireEvent.doubleClick(stage, { detail: 2, clientX: 400, clientY: 180 });
        act(() => {
          vi.advanceTimersByTime(350);
        });

        expect(play).toHaveBeenCalledTimes(1);
        expect(pause).not.toHaveBeenCalled();
        expect(screen.getByTestId('gesture-cue-toast')).toHaveTextContent('▶');
        expect(within(hud).getByRole('button', { name: '暂停', hidden: true })).toBeInTheDocument();
        expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');
        expect(hud).toHaveAttribute('data-visible', 'false');
        expect(setImmersive).toHaveBeenCalledTimes(1);

        // Second centre double-tap pauses playback without flashing HUD.
        fireEvent.doubleClick(stage, { detail: 2, clientX: 400, clientY: 180 });
        expect(pause).toHaveBeenCalledTimes(1);
        expect(within(hud).getByRole('button', { name: '播放', hidden: true })).toBeInTheDocument();
        expect(screen.getByTestId('gesture-cue-toast')).toHaveTextContent('⏸');
        expect(hud).toHaveAttribute('data-visible', 'false');
      } finally {
        play.mockRestore();
        pause.mockRestore();
      }
    });

    it('tapping a subtitle glyph in immersive pauses playback, immediately hides HUD, and opens SideSheet on AI 解析 tab', async () => {
      setViewport(915, 412);
      const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
      try {
        const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        const cue = await screen.findByTestId('overlay-cue');
        const hud = screen.getByTestId('player-hud');

        fireEvent.click(within(hud).getByRole('button', { name: '播放' }));
        pause.mockClear();
        expect(hud).toHaveAttribute('data-visible', 'true');

        fireEvent.click(glyphAt(cue, 2));

        expect(pause).toHaveBeenCalled();
        expect(hud).toHaveAttribute('data-visible', 'false');
        expect(screen.getByTestId('player')).toHaveClass('k-player--immersive', 'is-drawer-open');
        expect(container.querySelector('.k-bottom-sheet')).toBeNull();

        const drawer = container.querySelector('aside.k-side-sheet');
        expect(drawer).toHaveClass('is-open');
        expect(screen.getByRole('tab', { name: /AI 解析/ })).toHaveAttribute('aria-selected', 'true');
        await waitFor(() => expect(useBreakdownStore.getState().status).toBe('ready'));
        expect(within(drawer as HTMLElement).getByTestId('ai-breakdown-panel')).toBeInTheDocument();

        // Toggling the HUD drawer button wakes/keeps HUD and closes the drawer + clears breakdown.
        fireEvent.click(within(hud).getByTestId('immersive-drawer-toggle'));
        expect(hud).toHaveAttribute('data-visible', 'true');
        expect(drawer).not.toHaveClass('is-open');
        expect(useBreakdownStore.getState().isOpen).toBe(false);
      } finally {
        pause.mockRestore();
      }
    });

    it('portrait fullscreen-toggle uses host.screen.setImmersive when present and falls back to requestFullscreen when absent', async () => {
      setViewport(360, 800);
      const setImmersive = vi.fn().mockResolvedValue(undefined);

      // 1. Native Android bridge (`host.screen` present)
      const first = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />, {
        screen: { setImmersive },
      });
      await screen.findByTestId('overlay-cue');
      expect(screen.getByTestId('player')).toHaveClass('k-player--compact');
      expect(setImmersive).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
      expect(setImmersive).toHaveBeenCalledTimes(1);
      expect(setImmersive).toHaveBeenCalledWith({ immersive: true, orientation: 'landscape' });
      expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');
      expect(within(screen.getByTestId('player-hud')).getByTestId('fullscreen-toggle')).toHaveAttribute('aria-label', '退出全屏');

      fireEvent.click(within(screen.getByTestId('player-hud')).getByTestId('fullscreen-toggle'));
      expect(setImmersive).toHaveBeenCalledTimes(2);
      expect(setImmersive).toHaveBeenLastCalledWith({ immersive: false, orientation: 'portrait-then-unlock' });
      expect(screen.getByTestId('player')).toHaveClass('k-player--compact');
      first.unmount();

      // 2. Web Fullscreen fallback (`host.screen` absent)
      const requested: Element[] = [];
      const originalRequest = HTMLElement.prototype.requestFullscreen;
      HTMLElement.prototype.requestFullscreen = function (this: HTMLElement) {
        requested.push(this);
        return Promise.resolve();
      };
      try {
        renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        await screen.findByTestId('overlay-cue');
        fireEvent.click(screen.getByTestId('fullscreen-toggle'));
        expect(requested).toHaveLength(1);
        expect(requested[0]).toBe(screen.getByTestId('player'));
        expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');
      } finally {
        HTMLElement.prototype.requestFullscreen = originalRequest;
      }
    });

    it('unwinds Menu -> drawer -> fullscreen -> route goBack on Back / Escape, and cleans up setImmersive on unmount', async () => {
      setViewport(360, 800);
      useRouteStore.getState().openAnime({ kind: 'series', seriesId: 'series-kotori' });
      useRouteStore.getState().openAnime({ kind: 'player', seriesId: 'series-kotori', episodeId: 'series-kotori-ep1' });

      const setImmersive = vi.fn().mockResolvedValue(undefined);
      const { container, unmount } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />, {
        screen: { setImmersive },
      });
      const cue = await screen.findByTestId('overlay-cue');

      // Enter native fullscreen, open AI drawer via subtitle glyph, and open speed menu.
      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
      expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');
      fireEvent.click(glyphAt(cue, 0));
      await waitFor(() => expect(useBreakdownStore.getState().isOpen).toBe(true));
      expect(container.querySelector('aside.k-side-sheet')).toHaveClass('is-open');

      fireEvent.click(within(screen.getByTestId('player-hud')).getByTestId('speed-button'));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      // 1st Back: closes open Menu only.
      act(() => {
        expect(dispatchBackNavigation()).toBe(true);
      });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(container.querySelector('aside.k-side-sheet')).toHaveClass('is-open');
      expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');

      // 2nd Back: closes immersive drawer; stays in fullscreen.
      act(() => {
        expect(dispatchBackNavigation()).toBe(true);
      });
      expect(container.querySelector('aside.k-side-sheet')).not.toHaveClass('is-open');
      expect(useBreakdownStore.getState().isOpen).toBe(false);
      expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');

      // Escape follows the same drawer -> fullscreen unwind order.
      fireEvent.click(within(screen.getByTestId('player-hud')).getByTestId('immersive-drawer-toggle'));
      expect(container.querySelector('aside.k-side-sheet')).toHaveClass('is-open');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(container.querySelector('aside.k-side-sheet')).not.toHaveClass('is-open');
      expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByTestId('player')).toHaveClass('k-player--compact');
      expect(setImmersive).toHaveBeenLastCalledWith({ immersive: false, orientation: 'portrait-then-unlock' });

      // Re-enter fullscreen -> Back exits fullscreen -> next Back navigates player -> series.
      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
      expect(screen.getByTestId('player')).toHaveClass('k-player--immersive');
      act(() => {
        expect(dispatchBackNavigation()).toBe(true);
      });
      expect(screen.getByTestId('player')).toHaveClass('k-player--compact');
      expect(useRouteStore.getState().anime.kind).toBe('player');
      act(() => {
        expect(dispatchBackNavigation()).toBe(true);
      });
      expect(useRouteStore.getState().anime).toEqual({ kind: 'series', seriesId: 'series-kotori' });

      // Lock fullscreen again and unmount -> restores portrait-then-unlock.
      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
      setImmersive.mockClear();
      unmount();
      expect(setImmersive).toHaveBeenCalledTimes(1);
      expect(setImmersive).toHaveBeenCalledWith({ immersive: false, orientation: 'portrait-then-unlock' });

      // Physical mobileLandscape rotation with host.screen -> hides bars with 'keep' and restores 'keep' on unmount.
      setImmersive.mockClear();
      setViewport(915, 412);
      const rotated = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />, {
        screen: { setImmersive },
      });
      await screen.findByTestId('overlay-cue');
      expect(setImmersive).toHaveBeenCalledTimes(1);
      expect(setImmersive).toHaveBeenCalledWith({ immersive: true, orientation: 'keep' });
      setImmersive.mockClear();
      rotated.unmount();
      expect(setImmersive).toHaveBeenCalledTimes(1);
      expect(setImmersive).toHaveBeenCalledWith({ immersive: false, orientation: 'keep' });
    });
  });

  describe('secondary subtitles (副字幕)', () => {
    it('#0 regression at 45 s with zh auto-enabled: primary overlay-cue resolves one element and secondary is absent when no zh cue is active', async () => {
      const { host } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      const primary = await screen.findByTestId('overlay-cue');
      await waitFor(() => expect(host.calls.get('anime.getCues')).toBe(2));
      expect(screen.getAllByTestId('overlay-cue')).toHaveLength(1);
      expect(primary.textContent).toBe('え、何の話だっけ？');
      expect(screen.queryByTestId('overlay-secondary-cue')).toBeNull();
    });

    it('#1–#2 auto secondary renders Chinese cue below primary inside .k-sub-overlay__bottom with k-sub-line--secondary and lang="zh-CN"', async () => {
      expect(playerCss).toMatch(/\.k-sub-line--secondary\s*\{[^}]*pointer-events:\s*none;/s);
      expect(playerCss).toMatch(/\.k-player--immersive\s+\.k-hud\[data-visible="true"\]\s*~\s*\.k-sub-overlay\s+\.k-sub-line--secondary\s*\{[^}]*-webkit-line-clamp:\s*1;/s);
      expect(playerCss).toMatch(/@media\s*\(max-height:\s*460px\)\s*\{[\s\S]*?\.k-player--immersive\s+\.k-hud\[data-visible="true"\]\s*~\s*\.k-sub-overlay\s+\.k-sub-line--secondary\s*\{[^}]*display:\s*none;/);
      expect(playerCss).toMatch(/\.k-track-delay\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s);

      renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      const row = await rowByText('おはよう、ことり。今日も早いね。');
      fireEvent.click(row.querySelector<HTMLButtonElement>('.k-transcript__time')!);

      const sec = await screen.findByTestId('overlay-secondary-cue');
      const pri = screen.getByTestId('overlay-cue');
      expect(pri.textContent).toBe('おはよう、ことり。今日も早いね。');
      expect(sec.textContent).toBe('早啊，小鸟。今天也这么早。');
      expect(sec).toHaveClass('k-sub-line', 'k-sub-line--secondary');
      expect(sec).toHaveAttribute('lang', 'zh-CN');
      expect(sec.parentElement).toBe(pri.parentElement);
      expect(sec.parentElement).toHaveClass('k-sub-overlay__bottom');
      expect(Boolean(pri.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });

    it('#3 menu track-secondary-off hides secondary cue, shows snackbar, and persists secondarySubtitle: off', async () => {
      const { host } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      const row = await rowByText('おはよう、ことり。今日も早いね。');
      fireEvent.click(row.querySelector<HTMLButtonElement>('.k-transcript__time')!);
      expect(await screen.findByTestId('overlay-secondary-cue')).toHaveTextContent('早啊，小鸟。今天也这么早。');

      fireEvent.click(screen.getByRole('button', { name: '字幕轨' }));
      fireEvent.click(screen.getByTestId('track-secondary-off'));

      expect(screen.queryByTestId('overlay-secondary-cue')).toBeNull();
      expect(useSnackbarStore.getState().queue.at(-1)?.text).toBe('已关闭副字幕');
      await waitFor(async () => {
        expect(useSettingsStore.getState().settings.anime.secondarySubtitle).toBe('off');
        expect((await host.settings.get()).anime.secondarySubtitle).toBe('off');
      });

      // Re-selecting the zh track turns secondary back on and promotes zh-CN in preferredSecondarySubtitleLanguages
      fireEvent.click(screen.getByRole('button', { name: '字幕轨' }));
      fireEvent.click(screen.getByTestId('track-secondary-series-kotori-ep1-zh'));
      expect(await screen.findByTestId('overlay-secondary-cue')).toHaveTextContent('早啊，小鸟。今天也这么早。');
      expect(useSnackbarStore.getState().queue.at(-1)?.text).toMatch(/^已开启副字幕：/);
      await waitFor(() => {
        expect(useSettingsStore.getState().settings.anime.secondarySubtitle).toBe('auto');
        expect(useSettingsStore.getState().settings.anime.preferredSecondarySubtitleLanguages?.[0]).toBe('zh-CN');
      });
    });

    it('#4 menu omits current primary from secondary section, extracts embedded track as secondary without touching primary, and emits no duplicate-key warnings', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { host } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        await screen.findByTestId('overlay-cue');
        await waitFor(() => expect(host.calls.get('anime.getCues')).toBe(2));

        fireEvent.click(screen.getByRole('button', { name: '字幕轨' }));
        expect(screen.getByText('主字幕 · 点击查词 / AI 解析')).toBeInTheDocument();
        expect(screen.getByText('副字幕 · 主字幕下方小字')).toBeInTheDocument();

        // Primary track is in primary section, NOT in secondary section
        expect(screen.getByTestId('track-primary-series-kotori-ep1-ja')).toHaveClass('is-selected');
        expect(screen.queryByTestId('track-secondary-series-kotori-ep1-ja')).toBeNull();
        expect(screen.getByTestId('track-secondary-series-kotori-ep1-zh')).toHaveClass('is-selected');
        expect(screen.getByTestId('track-secondary-series-kotori-ep1-emb2')).toBeInTheDocument();

        const consoleErrors = errSpy.mock.calls.flat().map(String).join('\n');
        expect(consoleErrors).not.toMatch(/Encountered two children with the same key/i);

        // Extract unextracted embedded track into secondary slot -> primary stays untouched
        fireEvent.click(screen.getByTestId('track-secondary-series-kotori-ep1-emb2'));
        await waitFor(() => expect(host.calls.get('anime.extractEmbeddedTrack')).toBe(1));

        await waitFor(() => {
          fireEvent.click(screen.getByRole('button', { name: '字幕轨' }));
          expect(screen.getByTestId('track-primary-series-kotori-ep1-ja')).toHaveClass('is-selected');
          expect(screen.getByTestId('track-secondary-series-kotori-ep1-emb2')).toHaveClass('is-selected');
        });
      } finally {
        errSpy.mockRestore();
      }
    });

    it('#5 switching primary to the zh track clears overlay-secondary-cue via same-track guard', async () => {
      renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      const row = await rowByText('おはよう、ことり。今日も早いね。');
      fireEvent.click(row.querySelector<HTMLButtonElement>('.k-transcript__time')!);
      expect(await screen.findByTestId('overlay-secondary-cue')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '字幕轨' }));
      fireEvent.click(screen.getByTestId('track-primary-series-kotori-ep1-zh'));

      await waitFor(() => expect(screen.getByTestId('overlay-cue').textContent).toBe('早啊，小鸟。今天也这么早。'));
      expect(screen.queryByTestId('overlay-secondary-cue')).toBeNull();
    });

    it('#6 pressing B hides both primary and secondary cues', async () => {
      renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      const row = await rowByText('おはよう、ことり。今日も早いね。');
      fireEvent.click(row.querySelector<HTMLButtonElement>('.k-transcript__time')!);
      expect(await screen.findByTestId('overlay-secondary-cue')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'b' });
      expect(screen.getByTestId('sub-overlay-hidden')).toBeInTheDocument();
      expect(screen.queryByTestId('overlay-cue')).toBeNull();
      expect(screen.queryByTestId('overlay-secondary-cue')).toBeNull();
    });

    it('#7 episode without a matching translation track (series-kotori-ep2) renders no secondary cue', async () => {
      renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep2" />);
      const row = await rowByText('おはよう、ことり。今日も早いね。');
      fireEvent.click(row.querySelector<HTMLButtonElement>('.k-transcript__time')!);
      expect((await screen.findByTestId('overlay-cue')).textContent).toBe('おはよう、ことり。今日も早いね。');
      expect(screen.queryByTestId('overlay-secondary-cue')).toBeNull();
    });

    it('#8 transcript row with matching secondary cue shows transcript-secondary while unmatched row has none', async () => {
      const { host } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      await waitFor(() => expect(host.calls.get('anime.getCues')).toBe(2));

      const matchedRow = await rowByText('おはよう、ことり。今日も早いね。');
      await waitFor(() =>
        expect(within(matchedRow).getByTestId('transcript-secondary')).toHaveTextContent('早啊，小鸟。今天也这么早。'),
      );

      const unmatchedRow = await rowByText('え、何の話だっけ？');
      expect(within(unmatchedRow).queryByTestId('transcript-secondary')).toBeNull();
    });

    it('#9 secondary +100 delay adjusts only secondary track and does not pin auto or mutate persisted settings', async () => {
      const { host } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
      await screen.findByTestId('overlay-cue');
      await waitFor(() => expect(host.calls.get('anime.getCues')).toBe(2));

      const setDelaySpy = vi.spyOn(host.anime, 'setTrackDelay');
      fireEvent.click(screen.getByRole('button', { name: '字幕轨' }));

      expect(screen.getByTestId('track-delay-primary')).toHaveTextContent('主字幕延迟 0 ms');
      const secDelayRow = screen.getByTestId('track-delay-secondary');
      expect(secDelayRow).toHaveTextContent('副字幕延迟 0 ms');

      fireEvent.click(within(secDelayRow).getByRole('button', { name: '+100' }));
      await waitFor(() => expect(setDelaySpy).toHaveBeenCalledTimes(1));
      expect(setDelaySpy).toHaveBeenCalledWith('series-kotori-ep1-zh', 100);
      expect(host.calls.get('settings.update')).toBeUndefined();
      expect(useSettingsStore.getState().settings.anime.secondarySubtitle).toBe('auto');
      expect(useSettingsStore.getState().settings.anime.preferredSecondarySubtitleLanguages).toEqual(['zh-CN', 'zh', 'zh-TW', 'en']);

      await waitFor(() => expect(screen.getByTestId('track-delay-secondary')).toHaveTextContent('副字幕延迟 100 ms'));
    });

    it('#10 bilingual primary track holds off getCues(zh) while loading, keeps auto secondary undefined, and suppresses inline span only when secondary is manually chosen', async () => {
      const host = createMockPlatformHost({ latencyMs: 0, streamDelayMs: 0 });
      const origGetCues = host.anime.getCues.bind(host.anime);
      let resolvePrimary!: (value: ParsedSubtitleTrack) => void;
      const primaryGate = new Promise<ParsedSubtitleTrack>((r) => {
        resolvePrimary = r;
      });

      const getCuesSpy = vi.spyOn(host.anime, 'getCues').mockImplementation((id: string) => {
        if (id === 'series-kotori-ep1-ja') return primaryGate;
        return origGetCues(id);
      });

      render(
        <HostProvider host={host}>
          <Player seriesId="series-kotori" episodeId="series-kotori-ep1" />
        </HostProvider>,
      );

      // Wait until PlayerView mounted and issued primary getCues
      await waitFor(() => expect(getCuesSpy).toHaveBeenCalledWith('series-kotori-ep1-ja'));
      // While cuesQ.loading is true, no secondary getCues(zh) call is issued!
      expect(getCuesSpy).not.toHaveBeenCalledWith('series-kotori-ep1-zh');

      const bilingualTrack: ParsedSubtitleTrack = {
        info: { format: 'ass', encoding: 'utf-8', language: 'ja' },
        cues: [
          {
            index: 0,
            startMs: 32_000,
            endMs: 34_600,
            text: 'おはよう、ことり。今日も早いね。\n早安，小鸟（内嵌双语）',
            rawText: 'おはよう、ことり。今日も早いね。\\N早安，小鸟（内嵌双语）',
          },
          {
            index: 1,
            startMs: 43_500,
            endMs: 45_500,
            text: 'え、何の話だっけ？\n诶，在说什么来着？（内嵌双语）',
            rawText: 'え、何の話だっけ？\\N诶，在说什么来着？（内嵌双语）',
          },
        ],
        warnings: [],
      };

      await act(async () => {
        resolvePrimary(bilingualTrack);
        await primaryGate;
      });

      const cueAt45 = await screen.findByTestId('overlay-cue');
      expect(cueAt45.querySelector('.k-sub-line__secondary')?.textContent).toBe('诶，在说什么来着？（内嵌双语）');
      expect(screen.queryByTestId('overlay-secondary-cue')).toBeNull();
      expect(getCuesSpy).not.toHaveBeenCalledWith('series-kotori-ep1-zh');

      // Seek to 32 s and manually enable the external zh track -> inline .k-sub-line__secondary is suppressed in favor of overlay-secondary-cue
      const row0 = await rowByText('おはよう、ことり。今日も早いね。');
      fireEvent.click(row0.querySelector<HTMLButtonElement>('.k-transcript__time')!);
      expect(screen.getByTestId('overlay-cue').querySelector('.k-sub-line__secondary')?.textContent).toBe('早安，小鸟（内嵌双语）');

      fireEvent.click(screen.getByRole('button', { name: '字幕轨' }));
      fireEvent.click(screen.getByTestId('track-secondary-series-kotori-ep1-zh'));

      expect(await screen.findByTestId('overlay-secondary-cue')).toHaveTextContent('早啊，小鸟。今天也这么早。');
      expect(screen.getByTestId('overlay-cue').querySelector('.k-sub-line__secondary')).toBeNull();
    });

    it('stacks .k-sub-overlay above .k-player__sim in portrait/expanded layouts so simulated stage never paints over subtitles', async () => {
      const zOf = (selectorPattern: RegExp): number => {
        const block = selectorPattern.exec(playerCss)?.[1] ?? '';
        const z = /z-index:\s*(\d+)\s*;/.exec(block)?.[1];
        return z === undefined ? Number.NaN : Number(z);
      };
      const simZ = zOf(/(?:^|\n)\.k-player__sim\s*\{([^}]*)\}/);
      const overlayZ = zOf(/(?:^|\n)\.k-sub-overlay\s*\{([^}]*)\}/);
      const immersiveOverlayZ = zOf(/\.k-player--immersive\s+\.k-sub-overlay\s*\{([^}]*)\}/);
      const subsHiddenZ = zOf(/(?:^|\n)\.k-player__subs-hidden\s*\{([^}]*)\}/);

      expect(simZ).toBe(1);
      expect(overlayZ).toBeGreaterThan(simZ);
      expect(overlayZ).toBe(5);
      expect(immersiveOverlayZ).toBeGreaterThan(overlayZ);
      expect(subsHiddenZ).toBeGreaterThan(immersiveOverlayZ);

      setViewport(390, 844);
      try {
        const { container } = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        const row = await rowByText('おはよう、ことり。今日も早いね。');
        fireEvent.error(container.querySelector('video')!);
        fireEvent.click(row.querySelector<HTMLButtonElement>('.k-transcript__time')!);

        const pri = await screen.findByTestId('overlay-cue');
        const sec = await screen.findByTestId('overlay-secondary-cue');
        const playerRoot = container.querySelector('.k-player');
        const sim = container.querySelector('.k-player__sim');
        const overlay = container.querySelector('.k-sub-overlay');
        expect(playerRoot).not.toHaveClass('k-player--immersive');
        expect(sim).not.toBeNull();
        expect(overlay).not.toBeNull();
        expect(sim?.parentElement).toBe(overlay?.parentElement);
        expect(overlay).toContainElement(pri);
        expect(overlay).toContainElement(sec);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('bottom-anchored subtitles & balanced line wrapping (§1, §4, §5)', () => {
    const noHl = () => ({ span: undefined, focus: undefined, focusSpan: undefined, explaining: false });
    const makeCue = (index: number, text: string): SubtitleCue => ({
      index,
      startMs: 1000,
      endMs: 4000,
      text,
      rawText: text,
    });

    it('balances a 13-char primary cue into two >= 3-glyph lines, leaves a 12-char cue on 1 line, and preserves exact click offsets', () => {
      const onCharClick = vi.fn();
      const metrics = { primaryMaxEm: 12, secondaryMaxEm: 16, inlineSecondaryMaxEm: 16 };

      // 13-char cue (> 12 em) -> 1 soft <br> at index 6 ('今日は本当に' / '楽しかったね。').
      const cue13 = makeCue(0, '今日は本当に楽しかったね。');
      const { container, rerender } = render(
        <SubtitleOverlay
          cues={[cue13]}
          activeIndexes={[0]}
          mergeKaraoke={false}
          blind={false}
          onCharClick={onCharClick}
          highlightFor={noHl}
          lineMetrics={metrics}
        />,
      );

      const wbrs = container.querySelectorAll('br.k-ruby-text__wbr');
      expect(wbrs).toHaveLength(1);
      const breakIdx = Number(wbrs[0]?.getAttribute('data-soft-break'));
      expect(breakIdx).toBe(6);

      const allGlyphs = [...container.querySelectorAll('[data-glyph]')];
      const line1Glyphs = allGlyphs.filter((g) => Number(g.getAttribute('data-char-start')) < breakIdx);
      const line2Glyphs = allGlyphs.filter((g) => Number(g.getAttribute('data-char-start')) >= breakIdx);
      expect(line1Glyphs.length).toBeGreaterThanOrEqual(3);
      expect(line2Glyphs.length).toBeGreaterThanOrEqual(3);

      // Clicking first glyph of line 2 ('楽') reports exact UTF-16 index 6.
      fireEvent.click(glyphAt(container, 6));
      expect(onCharClick).toHaveBeenLastCalledWith(cue13, 6);

      // 12-char cue (=== 12 em) -> 0 soft <br>.
      const cue12 = makeCue(0, '食べちゃった。もう無理…');
      rerender(
        <SubtitleOverlay
          cues={[cue12]}
          activeIndexes={[0]}
          mergeKaraoke={false}
          blind={false}
          onCharClick={onCharClick}
          highlightFor={noHl}
          lineMetrics={metrics}
        />,
      );
      expect(container.querySelectorAll('br.k-ruby-text__wbr')).toHaveLength(0);
    });

    it('balances secondary zh track when secondaryMaxLines={2}, skips balancing when secondaryMaxLines={1}, and defaults to Infinity in jsdom', () => {
      const metrics = { primaryMaxEm: 12, secondaryMaxEm: 14, inlineSecondaryMaxEm: 14 };
      const pri = makeCue(0, '今日は本当に楽しかったね。');
      const sec = makeCue(0, '我觉得这件事情还是应该再考虑一下比较好');

      // With secondaryMaxLines={2} (default): secondary text inside .k-sub-line--secondary__text gets 1 '\n'.
      const { container, rerender } = render(
        <SubtitleOverlay
          cues={[pri]}
          activeIndexes={[0]}
          mergeKaraoke={false}
          blind={false}
          onCharClick={() => {}}
          highlightFor={noHl}
          secondaryCues={[sec]}
          secondaryActiveIndexes={[0]}
          secondaryLang="zh-CN"
          lineMetrics={metrics}
          secondaryMaxLines={2}
        />,
      );

      const secInner = container.querySelector('.k-sub-line--secondary .k-sub-line--secondary__text');
      expect(secInner).not.toBeNull();
      expect(secInner?.textContent?.split('\n')).toHaveLength(2);

      // With secondaryMaxLines={1} (immersive + HUD visible): secondary is NOT balanced so clamp=1 fills the first line.
      rerender(
        <SubtitleOverlay
          cues={[pri]}
          activeIndexes={[0]}
          mergeKaraoke={false}
          blind={false}
          onCharClick={() => {}}
          highlightFor={noHl}
          secondaryCues={[sec]}
          secondaryActiveIndexes={[0]}
          secondaryLang="zh-CN"
          lineMetrics={metrics}
          secondaryMaxLines={1}
        />,
      );
      expect(container.querySelector('.k-sub-line--secondary__text')?.textContent).toBe(sec.text);

      // Without lineMetrics in jsdom (probe fontSize unresolved -> Infinity), neither primary nor secondary wraps in JS,
      // and toggling blind <-> normal keeps hook ordering unconditional.
      rerender(
        <SubtitleOverlay
          cues={[pri]}
          activeIndexes={[0]}
          mergeKaraoke={false}
          blind={false}
          onCharClick={() => {}}
          highlightFor={noHl}
          secondaryCues={[sec]}
          secondaryActiveIndexes={[0]}
          secondaryLang="zh-CN"
        />,
      );
      expect(container.querySelectorAll('br.k-ruby-text__wbr')).toHaveLength(0);
      expect(container.querySelector('.k-sub-line--secondary__text')?.textContent).toBe(sec.text);

      rerender(
        <SubtitleOverlay
          cues={[pri]}
          activeIndexes={[0]}
          mergeKaraoke={false}
          blind={true}
          onCharClick={() => {}}
          highlightFor={noHl}
          secondaryCues={[sec]}
          secondaryActiveIndexes={[0]}
          secondaryLang="zh-CN"
          lineMetrics={metrics}
        />,
      );
      expect(screen.getByTestId('sub-overlay-hidden')).toBeInTheDocument();

      rerender(
        <SubtitleOverlay
          cues={[pri]}
          activeIndexes={[0]}
          mergeKaraoke={false}
          blind={false}
          onCharClick={() => {}}
          highlightFor={noHl}
          secondaryCues={[sec]}
          secondaryActiveIndexes={[0]}
          secondaryLang="zh-CN"
          lineMetrics={metrics}
        />,
      );
      expect(container.querySelectorAll('br.k-ruby-text__wbr')).toHaveLength(1);
    });

    it('measures live probe fontSize & overlay width when resolved, and never synthesises fontPx when unresolved', () => {
      const origGetComputedStyle = window.getComputedStyle.bind(window);
      const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element) => {
        const base = origGetComputedStyle(elt);
        if (elt.classList.contains('k-sub-overlay')) {
          return new Proxy(base, {
            get(target, prop, receiver) {
              if (prop === 'paddingLeft' || prop === 'paddingRight') return '10px';
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        if (elt.classList.contains('k-sub-line--probe')) {
          const isSec = elt.classList.contains('k-sub-line--secondary');
          return new Proxy(base, {
            get(target, prop, receiver) {
              if (prop === 'fontSize') return isSec ? '14px' : '20px';
              if (prop === 'maxWidth') return isSec ? '92%' : '96%';
              if (prop === 'paddingLeft' || prop === 'paddingRight') return '8px';
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return base;
      });
      const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('k-sub-overlay') ? 280 : 0;
        },
      });

      try {
        // W = 280 - 20 = 260; primaryMaxEm = (260 * 0.96 - 16) / 20 - 0.15 = 11.53 -> 13-char cue wraps!
        const cue13 = makeCue(0, '今日は本当に楽しかったね。');
        const { container } = render(
          <SubtitleOverlay
            cues={[cue13]}
            activeIndexes={[0]}
            mergeKaraoke={false}
            blind={false}
            onCharClick={() => {}}
            highlightFor={noHl}
          />,
        );
        expect(container.querySelectorAll('br.k-ruby-text__wbr')).toHaveLength(1);
      } finally {
        spy.mockRestore();
        if (origClientWidth) {
          Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth);
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
        }
      }
    });

    it('anchors subtitles near the stage bottom in CSS (6px expanded, 4px compact, 4px immersive HUD-hidden) and keeps HUD-visible lift intact', async () => {
      expect(playerCss).toMatch(/\.k-sub-overlay\s*\{[^}]*padding:\s*2\.5%\s+3%\s+6px;/s);
      expect(playerCss).toMatch(/\.k-player--compact\s+\.k-sub-overlay\s*\{[^}]*padding:\s*2%\s+2\.5%\s+4px;/s);
      expect(playerCss).toMatch(/\.k-sub-overlay__top,\s*\.k-sub-overlay__bottom\s*\{[^}]*gap:\s*4px;/s);
      expect(playerCss).toMatch(/\.k-player--compact\s+\.k-sub-overlay__top,\s*\.k-player--compact\s+\.k-sub-overlay__bottom\s*\{[^}]*gap:\s*2px;/s);
      expect(playerCss).toMatch(/\.k-sub-line\s*\{[^}]*text-wrap:\s*balance;/s);
      expect(playerCss).toMatch(/\.k-sub-line__secondary\s*\{[^}]*white-space:\s*pre-line;[^}]*text-wrap:\s*balance;/s);
      expect(playerCss).toMatch(/\.k-sub-line--secondary__text\s*\{[^}]*display:\s*block;[^}]*white-space:\s*pre-line;[^}]*text-wrap:\s*balance;/s);
      expect(playerCss).toMatch(/\.k-sub-line--probe\s*\{[^}]*position:\s*absolute;[^}]*visibility:\s*hidden;[^}]*height:\s*0;[^}]*pointer-events:\s*none;/s);
      expect(playerCss).toMatch(
        /\.k-player--immersive\s+\.k-sub-overlay\s*\{[^}]*--k-sub-bottom:\s*max\(4px,\s*calc\(var\(--k-safe-bottom\)\s*\+\s*4px\)\);[^}]*max\(3%,\s*calc\(var\(--k-stage-safe-right,\s*0px\)\s*\+\s*12px\)\)[^}]*max\(3%,\s*calc\(var\(--k-stage-safe-left,\s*0px\)\s*\+\s*12px\)\)/s,
      );
      expect(playerCss).toMatch(
        /\.k-player--immersive\s+\.k-hud\[data-visible="true"\]\s*~\s*\.k-sub-overlay\s*\{[^}]*--k-sub-bottom:\s*calc\(var\(--k-hud-bottom-h,\s*88px\)\s*\+\s*var\(--k-safe-bottom\)\s*\+\s*8px\);/s,
      );

      // Verify computed paddingBottom in jsdom with player.css loaded.
      const styleEl = document.createElement('style');
      styleEl.textContent = playerCss;
      document.head.appendChild(styleEl);
      try {
        // Expanded (1280×800) -> 6px
        setViewport(1280, 800);
        const exp = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        await screen.findByTestId('overlay-cue');
        const expOverlay = exp.container.querySelector<HTMLElement>('.k-sub-overlay')!;
        expect(window.getComputedStyle(expOverlay).paddingBottom).toBe('6px');
        exp.unmount();

        // Compact portrait (390×844) -> 4px
        setViewport(390, 844);
        const cmp = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        await screen.findByTestId('overlay-cue');
        const cmpOverlay = cmp.container.querySelector<HTMLElement>('.k-sub-overlay')!;
        expect(window.getComputedStyle(cmpOverlay).paddingBottom).toBe('4px');
        cmp.unmount();

        // Immersive (800×360) with HUD hidden (data-visible="false") -> --k-sub-bottom resolves to max(4px, ...)
        setViewport(800, 360);
        const imm = renderWithHost(<Player seriesId="series-kotori" episodeId="series-kotori-ep1" />);
        const cue = await screen.findByTestId('overlay-cue');
        fireEvent.click(glyphAt(cue, 0)); // hides HUD in immersive
        expect(screen.getByTestId('player-hud')).toHaveAttribute('data-visible', 'false');
        const immOverlay = imm.container.querySelector<HTMLElement>('.k-sub-overlay')!;
        expect(window.getComputedStyle(immOverlay).getPropertyValue('--k-sub-bottom').trim()).toBe(
          'max(4px, calc(var(--k-safe-bottom) + 4px))',
        );
        imm.unmount();
      } finally {
        styleEl.remove();
        vi.unstubAllGlobals();
      }
    });
  });
});
