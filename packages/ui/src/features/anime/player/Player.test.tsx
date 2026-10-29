import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../app/default-settings';
import { dispatchBackNavigation, useRouteStore } from '../../../app/routes';
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
});
