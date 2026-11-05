import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatformHost, type MockPlatformHost } from '../host/mock-host';
import { resetStores } from '../test/utils';
import { App } from './App';
import { useRouteStore } from './routes';
import { installPointerEventPolyfill } from '../test/pointer';

/** Phone viewport for `matchMedia` (compact shell with the bottom NavBar). */
function setPhoneViewport(): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const minW = /min-width:\s*(\d+)px/.exec(query);
    const minH = /min-height:\s*(\d+)px/.exec(query);
    const matches = minW || minH ? (!minW || 360 >= Number(minW[1])) && (!minH || 800 >= Number(minH[1])) : false;
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  });
}

type Kind = 'touch' | 'mouse';
let pointerId = 1;

function swipe(el: Element, dir: 'left' | 'right', kind: Kind = 'touch', y = 320): void {
  const [fromX, toX] = dir === 'left' ? [420, 200] : [200, 420];
  if (kind === 'touch') {
    fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: y }] });
    fireEvent.touchMove(el, { touches: [{ clientX: (fromX + toX) / 2, clientY: y + 2 }] });
    fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: toX, clientY: y + 4 }] });
  } else {
    const id = pointerId++;
    fireEvent.pointerDown(el, { pointerType: 'mouse', pointerId: id, button: 0, clientX: fromX, clientY: y });
    fireEvent.pointerMove(el, { pointerType: 'mouse', pointerId: id, clientX: (fromX + toX) / 2, clientY: y + 2 });
    fireEvent.pointerUp(el, { pointerType: 'mouse', pointerId: id, button: 0, clientX: toX, clientY: y + 4 });
  }
}

const content = (): HTMLElement => document.querySelector<HTMLElement>('.k-shell__content')!;
/** `tab` or `downloads/<sub-tab>`. */
const where = (): string => {
  const s = useRouteStore.getState();
  return s.tab === 'downloads' ? `downloads/${s.downloadsTab}` : s.tab;
};
/** Swipe target: the innermost page so nested strips see the gesture too. */
const page = (): HTMLElement => content().querySelector<HTMLElement>('.k-page') ?? content();

let host: MockPlatformHost;

async function renderApp(): Promise<void> {
  setPhoneViewport();
  host = createMockPlatformHost({ latencyMs: 0 });
  render(<App host={host} />);
  await screen.findByTestId('series-series-kotori');
}

describe('Shell horizontal tab swipe', () => {
  let uninstallPointerEvent: () => void = () => {};
  beforeAll(() => {
    uninstallPointerEvent = installPointerEventPolyfill();
  });
  afterAll(() => uninstallPointerEvent());
  beforeEach(resetStores);
  afterEach(async () => {
    await act(async () => {
      await host.dispose();
    });
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each<[Kind]>([['touch'], ['mouse']])(
    'chains anime → manga → downloads(tasks…manga) → settings and back symmetrically (%s), without bloating history',
    async (kind) => {
      await renderApp();
      const forward = [
        'manga',
        'downloads/tasks',
        'downloads/anime',
        'downloads/subtitles',
        'downloads/manga',
        'settings',
      ];
      for (const expected of forward) {
        swipe(page(), 'left', kind);
        expect(where()).toBe(expected);
        expect(content().dataset['tab']).toBe(expected.split('/')[0]);
      }
      swipe(page(), 'left', kind); // settings is the last destination
      expect(where()).toBe('settings');

      const backward = [
        'downloads/manga', // entering Downloads from the right lands on its last sub-tab
        'downloads/subtitles',
        'downloads/anime',
        'downloads/tasks',
        'manga',
        'anime',
      ];
      for (const expected of backward) {
        swipe(page(), 'right', kind);
        expect(where()).toBe(expected);
      }
      swipe(page(), 'right', kind); // anime is the first destination
      expect(where()).toBe('anime');
      // Swiping back over the same path pops instead of pushing: the back stack is empty again.
      expect(useRouteStore.getState().history).toHaveLength(0);
    },
  );

  it('enters Downloads at 下载任务 on swipe-left from Manga, while the NavBar button keeps the last sub-tab', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setDownloadsTab('subtitles'));
    act(() => useRouteStore.getState().setTab('manga'));
    swipe(page(), 'left');
    expect(where()).toBe('downloads/tasks');

    act(() => useRouteStore.getState().setDownloadsTab('subtitles'));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(where()).toBe('downloads/subtitles');
  });

  it('each swipe adds at most one back-stack entry and Android back unwinds them in order', async () => {
    await renderApp();
    swipe(page(), 'left'); // manga
    swipe(page(), 'left'); // downloads/tasks (one entry, not two)
    swipe(page(), 'left'); // downloads/anime
    expect(useRouteStore.getState().history.map((h) => (h.tab === 'downloads' ? `downloads/${h.downloadsTab}` : h.tab))).toEqual([
      'anime',
      'manga',
      'downloads/tasks',
    ]);
    act(() => {
      window.__kotoriHandleBack?.();
    });
    expect(where()).toBe('downloads/tasks');
    act(() => {
      window.__kotoriHandleBack?.();
    });
    expect(where()).toBe('manga');
  });

  it('is disabled inside the episode player', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('series-series-kotori'));
    fireEvent.click(await screen.findByText('放課後の本屋'));
    const player = await screen.findByTestId('player');
    swipe(player, 'left');
    swipe(content(), 'left', 'mouse');
    expect(where()).toBe('anime');
    expect(useRouteStore.getState().anime.kind).toBe('player');
  });

  it('is disabled inside the manga reader but active in the manga library', async () => {
    await renderApp();
    act(() => useRouteStore.getState().openManga({ kind: 'reader', volumeId: 'vol-houkago-1' }));
    const reader = await screen.findByTestId('manga-reader');
    swipe(reader, 'left');
    swipe(reader, 'right', 'mouse');
    expect(where()).toBe('manga');
    expect(useRouteStore.getState().manga.kind).toBe('reader');

    act(() => useRouteStore.getState().openManga({ kind: 'library' }));
    swipe(page(), 'right');
    expect(where()).toBe('anime');
  });

  it('stays active on the anime Series Detail page', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('series-series-kotori'));
    await screen.findByText('放課後の本屋');
    expect(useRouteStore.getState().anime.kind).toBe('series');
    swipe(page(), 'left');
    expect(where()).toBe('manga');
  });

  it('ignores swipes from a React-portaled Dialog (feedback dialog inside Settings) and its inputs', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByTestId('open-agent-feedback-btn'));
    const dialog = screen.getByTestId('agent-feedback-dialog');
    expect(content().contains(dialog)).toBe(false);
    swipe(dialog, 'right');
    swipe(dialog, 'right', 'mouse');
    swipe(within(dialog).getByTestId('agent-feedback-summary-input'), 'right');
    expect(where()).toBe('settings');
  });

  it('ignores swipes on inputs, sliders and the 24px screen edges', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const settings = page();
    const input = settings.querySelector('input:not([type="hidden"])');
    expect(input).not.toBeNull();
    swipe(input!, 'right');
    const slider = settings.querySelector('[role="slider"], input[type="range"]');
    if (slider) swipe(slider, 'right');
    fireEvent.touchStart(settings, { touches: [{ clientX: 10, clientY: 300 }] });
    fireEvent.touchMove(settings, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchEnd(settings, { touches: [], changedTouches: [{ clientX: 260, clientY: 300 }] });
    expect(where()).toBe('settings');
  });

  it('respects horizontal scroll containers that can still scroll, chaining once they hit the edge', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    const tablist = screen.getByRole('tablist', { name: '下载' });
    tablist.style.overflowX = 'auto';
    Object.defineProperty(tablist, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(tablist, 'scrollLeft', { configurable: true, writable: true, value: 100 });
    // Scrolled to the middle: both directions belong to the overflowing tab bar.
    swipe(tablist, 'left');
    swipe(tablist, 'right');
    expect(where()).toBe('downloads/tasks');
    // At its left edge, swiping right chains: Downloads is at 'tasks' → Shell goes to Manga.
    tablist.scrollLeft = 0;
    swipe(tablist, 'right');
    expect(where()).toBe('manga');
  });

  it('suppresses the accidental card click when a horizontal swipe starts on a cover card', async () => {
    await renderApp();
    const card = screen.getByTestId('series-series-kotori');
    // Anime is the first destination: the swipe-right changes nothing, yet is still not a tap.
    swipe(card, 'right', 'mouse');
    fireEvent.click(card);
    expect(where()).toBe('anime');
    expect(useRouteStore.getState().anime.kind).toBe('library');
    // A genuine tap afterwards opens the series.
    fireEvent.click(card);
    expect(useRouteStore.getState().anime.kind).toBe('series');
  });

  it('swipes NyaaSearch Stage-2 视频种子 ⇄ 日语字幕 tabs, chaining to Downloads sub-tabs at the edges', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'anime' }));
    fireEvent.click((await screen.findAllByTestId('anime-series-card'))[0]!);
    await screen.findByTestId('series-detail-banner');
    const section = (): HTMLElement => document.querySelector<HTMLElement>('.k-dl-search')!;
    expect(section().dataset['detailTab']).toBe('torrents');

    swipe(section(), 'left'); // inner-most strip moves only
    expect(section().dataset['detailTab']).toBe('subtitles');
    expect(where()).toBe('downloads/anime');
    expect(screen.getByTestId('series-jimaku-panel')).toBeInTheDocument();

    swipe(section(), 'right');
    expect(section().dataset['detailTab']).toBe('torrents');
    expect(where()).toBe('downloads/anime');

    swipe(section(), 'right'); // torrents is the first detail tab: Downloads moves to 'tasks'
    expect(where()).toBe('downloads/tasks');
  });

  it('Stage-2 subtitles edge chains left to the Downloads 字幕 sub-tab', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'anime' }));
    fireEvent.click((await screen.findAllByTestId('anime-series-card'))[0]!);
    await screen.findByTestId('series-detail-banner');
    const section = document.querySelector<HTMLElement>('.k-dl-search')!;
    swipe(section, 'left');
    expect(section.dataset['detailTab']).toBe('subtitles');
    swipe(section, 'left');
    expect(where()).toBe('downloads/subtitles');
  });
});
