/**
 * Shell-level swipe motion: finger-following drag coordinated across the nested
 * Shell → Downloads → Nyaa Stage-2 strips, outermost rubber band, directional
 * slide-in on swipes and NavBar / tab bar taps, and no transform left on
 * `.k-shell__content` at rest or inside the player.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatformHost, type MockPlatformHost } from '../host/mock-host';
import { resetStores } from '../test/utils';
import { installPointerEventPolyfill } from '../test/pointer';
import { App } from './App';
import { useRouteStore } from './routes';

function setPhoneViewport(): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const minW = /min-width:\s*(\d+)px/.exec(query);
    const minH = /min-height:\s*(\d+)px/.exec(query);
    const matches = minW || minH ? (!minW || 360 >= Number(minW[1])) && (!minH || 800 >= Number(minH[1])) : false;
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  });
}

function swipe(el: Element, dir: 'left' | 'right', y = 320): void {
  const [fromX, toX] = dir === 'left' ? [420, 200] : [200, 420];
  fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchMove(el, { touches: [{ clientX: (fromX + toX) / 2, clientY: y + 2 }] });
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: toX, clientY: y + 4 }] });
}

const content = (): HTMLElement => document.querySelector<HTMLElement>('.k-shell__content')!;
const page = (): HTMLElement => content().querySelector<HTMLElement>('.k-page') ?? content();
const body = (): HTMLElement => screen.getByTestId('downloads-tabpanel');
const nyaaPane = (): HTMLElement => screen.getByTestId('nyaa-detail-pane');
const where = (): string => {
  const s = useRouteStore.getState();
  return s.tab === 'downloads' ? `downloads/${s.downloadsTab}` : s.tab;
};
/** Inline style + slide attribute: everything that could leave a containing block behind. */
const motionOf = (el: HTMLElement): string => `${el.getAttribute('style') ?? ''}|${el.getAttribute('data-tab-slide') ?? ''}`;
const AT_REST = '|';

let host: MockPlatformHost;

async function renderApp(): Promise<void> {
  setPhoneViewport();
  host = createMockPlatformHost({ latencyMs: 0 });
  render(<App host={host} />);
  await screen.findByTestId('series-series-kotori');
}

async function settle(el: HTMLElement): Promise<void> {
  await waitFor(() => expect(motionOf(el)).toBe(AT_REST), { timeout: 2000 });
}

describe('Shell swipe motion', () => {
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

  it('slides each destination in from the swipe direction, retriggering on rapid chained swipes, then rests clean', async () => {
    await renderApp();
    swipe(page(), 'left');
    expect(where()).toBe('manga');
    expect(content()).toHaveAttribute('data-tab-slide', 'next');
    swipe(page(), 'left');
    expect(where()).toBe('downloads/tasks');
    expect(content()).toHaveAttribute('data-tab-slide', 'next');
    // The freshly mounted Downloads page does not slide its own panel on entry.
    expect(body()).not.toHaveAttribute('data-tab-slide');
    swipe(page(), 'left');
    expect(where()).toBe('downloads/anime');
    expect(body()).toHaveAttribute('data-tab-slide', 'next');
    swipe(page(), 'right');
    expect(where()).toBe('downloads/tasks');
    expect(body()).toHaveAttribute('data-tab-slide', 'prev');
    swipe(page(), 'right');
    expect(where()).toBe('manga');
    expect(content()).toHaveAttribute('data-tab-slide', 'prev');

    await settle(content());
    expect(getComputedStyle(content()).transform === '' || getComputedStyle(content()).transform === 'none').toBe(true);
  });

  it('slides on NavBar and Downloads tab bar taps in the direction of the destination', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(where()).toBe('settings');
    expect(content()).toHaveAttribute('data-tab-slide', 'next');
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(content()).toHaveAttribute('data-tab-slide', 'prev');

    const tabs = within(screen.getByRole('tablist', { name: '下载' })).getAllByRole('tab');
    fireEvent.click(tabs[2]!); // tasks → subtitles
    expect(where()).toBe('downloads/subtitles');
    expect(body()).toHaveAttribute('data-tab-slide', 'next');
    fireEvent.click(tabs[0]!);
    expect(where()).toBe('downloads/tasks');
    expect(body()).toHaveAttribute('data-tab-slide', 'prev');
    await settle(body());
  });

  it('drags only the strip that can move: Downloads panel inside, the Shell page past the Downloads edge', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'tasks' }));
    const p = page();
    fireEvent.touchStart(p, { touches: [{ clientX: 300, clientY: 320 }] });
    fireEvent.touchMove(p, { touches: [{ clientX: 420, clientY: 320 }] }); // right: tasks is Downloads' first sub-tab
    expect(content().style.transform).toBe('translate3d(120px, 0, 0)');
    expect(body().style.transform).toBe('');
    fireEvent.touchMove(p, { touches: [{ clientX: 180, clientY: 320 }] }); // left: tasks → anime
    expect(content().style.transform).toBe('');
    expect(body().style.transform).toBe('translate3d(-120px, 0, 0)');
    fireEvent.touchEnd(p, { touches: [], changedTouches: [{ clientX: 180, clientY: 320 }] });
    expect(where()).toBe('downloads/anime');
    expect(body().style.transform).toBe('');
    expect(body()).toHaveAttribute('data-tab-slide', 'next');
    expect(motionOf(content())).toBe(AT_REST);
  });

  it('drags the Nyaa Stage-2 pane first, falling through to the Downloads panel at its edge', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'anime' }));
    fireEvent.click((await screen.findAllByTestId('anime-series-card'))[0]!);
    await screen.findByTestId('series-detail-banner');
    const section = document.querySelector<HTMLElement>('.k-dl-search')!;
    fireEvent.touchStart(section, { touches: [{ clientX: 400, clientY: 320 }] });
    fireEvent.touchMove(section, { touches: [{ clientX: 300, clientY: 320 }] }); // torrents → subtitles
    expect(nyaaPane().style.transform).toBe('translate3d(-100px, 0, 0)');
    expect(body().style.transform).toBe('');
    expect(content().style.transform).toBe('');
    fireEvent.touchMove(section, { touches: [{ clientX: 530, clientY: 320 }] }); // torrents edge → Downloads anime → tasks
    expect(nyaaPane().style.transform).toBe('');
    expect(body().style.transform).toBe('translate3d(130px, 0, 0)');
    expect(content().style.transform).toBe('');
    fireEvent.touchMove(section, { touches: [{ clientX: 250, clientY: 320 }] });
    fireEvent.touchEnd(section, { touches: [], changedTouches: [{ clientX: 250, clientY: 320 }] });
    expect(section.dataset['detailTab']).toBe('subtitles');
    expect(where()).toBe('downloads/anime');
    expect(nyaaPane()).toHaveAttribute('data-tab-slide', 'next');
    expect(nyaaPane().style.transform).toBe('');
    expect(motionOf(body())).toBe(AT_REST);

    // Tapping the 视频种子 chip slides back from the left (a real tap starts with a
    // touchstart, which also lifts the post-swipe click guard).
    const chip = screen.getByRole('button', { name: /视频种子/ });
    fireEvent.touchStart(chip, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchEnd(chip, { touches: [], changedTouches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.click(chip);
    expect(section.dataset['detailTab']).toBe('torrents');
    expect(nyaaPane()).toHaveAttribute('data-tab-slide', 'prev');
  });

  it('rubber-bands the Shell page at the outermost destinations and glides back', async () => {
    await renderApp();
    const p = page();
    fireEvent.touchStart(p, { touches: [{ clientX: 200, clientY: 320 }] });
    fireEvent.touchMove(p, { touches: [{ clientX: 300, clientY: 320 }] });
    expect(content().style.transform).toBe('translate3d(20px, 0, 0)');
    fireEvent.touchMove(p, { touches: [{ clientX: 700, clientY: 320 }] });
    expect(content().style.transform).toBe('translate3d(36px, 0, 0)');
    fireEvent.touchEnd(p, { touches: [], changedTouches: [{ clientX: 700, clientY: 320 }] });
    expect(where()).toBe('anime');
    expect(content().style.transform).toBe('translate3d(0px, 0, 0)');
    await settle(content());

    act(() => useRouteStore.getState().setTab('settings'));
    await settle(content());
    const s = page();
    fireEvent.touchStart(s, { touches: [{ clientX: 600, clientY: 320 }] });
    fireEvent.touchMove(s, { touches: [{ clientX: 450, clientY: 320 }] });
    expect(content().style.transform).toBe('translate3d(-30px, 0, 0)');
    fireEvent.touchCancel(s);
    expect(where()).toBe('settings');
    await settle(content());
  });

  it('keeps .k-shell__content free of any transform inside the player, even when a swipe lands on it', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('series-series-kotori'));
    fireEvent.click(await screen.findByText('放課後の本屋'));
    await screen.findByTestId('player');
    expect(motionOf(content())).toBe(AT_REST);

    // Leave the player for Manga (it stays the Anime destination's view), then swipe back onto it.
    act(() => useRouteStore.getState().setTab('manga'));
    expect(motionOf(content())).toBe(AT_REST); // re-entering the strip is not an animated tab change
    const p = page();
    fireEvent.touchStart(p, { touches: [{ clientX: 200, clientY: 320 }] });
    fireEvent.touchMove(p, { touches: [{ clientX: 330, clientY: 320 }] });
    expect(content().style.transform).toBe('translate3d(130px, 0, 0)');
    fireEvent.touchEnd(p, { touches: [], changedTouches: [{ clientX: 420, clientY: 320 }] });
    expect(where()).toBe('anime');
    expect(useRouteStore.getState().anime.kind).toBe('player');
    await screen.findByTestId('player');
    // Swipe commit onto the player: no drag offset, no slide-in, no will-change.
    expect(motionOf(content())).toBe(AT_REST);
  });
});
