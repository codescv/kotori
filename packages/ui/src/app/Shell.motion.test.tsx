/**
 * Shell-level ViewPager2 motion: the Shell `<TabPager>` (anime · manga · downloads ·
 * settings) and the nested Downloads / Nyaa Stage-2 pagers show the current and the
 * adjacent page side by side while dragging, commit without remounting the peeked page,
 * preview the Downloads entry sub-tab, rubber-band at the outermost ends, slide side by
 * side on NavBar / tab bar taps, and leave a single untransformed page at rest and
 * inside the player.
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

const content = (): HTMLElement => document.querySelector<HTMLElement>('.k-shell__content')!;
const shellPager = (): HTMLElement => content().querySelector<HTMLElement>('.k-shell__pager')!;
const slidesOf = (pager: HTMLElement): HTMLElement[] =>
  [...pager.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('k-pager__slide'));
const tabsOf = (pager: HTMLElement): string[] => slidesOf(pager).map((el) => el.dataset['pagerTab']!);
const slideOf = (pager: HTMLElement, tab: string): HTMLElement => slidesOf(pager).find((el) => el.dataset['pagerTab'] === tab)!;
const shellTabs = (): string[] => tabsOf(shellPager());
const shellSlide = (tab: string): HTMLElement => slideOf(shellPager(), tab);
/** The Downloads sub-tab pager inside the Shell `downloads` slide. */
const dlPager = (): HTMLElement => shellSlide('downloads').querySelector<HTMLElement>('[data-testid="downloads-tabpanel"]')!;
const nyaaPager = (): HTMLElement => screen.getByTestId('nyaa-detail-pane');
/** The page of the Shell's active slide (gesture target). */
const page = (): HTMLElement => {
  const active = slidesOf(shellPager()).find((el) => !el.hasAttribute('inert'))!;
  return active.querySelector<HTMLElement>('.k-page') ?? active;
};
const where = (): string => {
  const s = useRouteStore.getState();
  return s.tab === 'downloads' ? `downloads/${s.downloadsTab}` : s.tab;
};

function down(el: Element, x: number, y = 320): void {
  fireEvent.touchStart(el, { touches: [{ clientX: x, clientY: y }] });
}
function move(el: Element, x: number, y = 320): void {
  fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: y }] });
}
function up(el: Element, x: number, y = 320): void {
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: x, clientY: y }] });
}

/** Every element from `el` up to the document root is free of inline motion. */
function expectNoTransformedAncestor(el: Element): void {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const s = (n as HTMLElement).style;
    expect(`${n.className}:${s?.transform ?? ''}|${s?.willChange ?? ''}|${s?.contain ?? ''}`).toBe(`${n.className}:||`);
  }
}

let host: MockPlatformHost;

async function renderApp(): Promise<void> {
  setPhoneViewport();
  host = createMockPlatformHost({ latencyMs: 0 });
  render(<App host={host} />);
  await screen.findByTestId('series-series-kotori');
}

/** Waits until the pager holds only `tab`, with no inline motion left on it. */
async function settled(pager: () => HTMLElement, tab: string): Promise<void> {
  await waitFor(
    () => {
      expect(tabsOf(pager())).toEqual([tab]);
      expect(slideOf(pager(), tab).getAttribute('style') ?? '').toBe('');
    },
    { timeout: 2000 },
  );
  const el = slideOf(pager(), tab);
  expect(el).not.toHaveAttribute('inert');
  expect(el).not.toHaveAttribute('aria-hidden');
  expect(pager()).not.toHaveAttribute('data-pager-moving');
}

describe('Shell ViewPager2 motion', () => {
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

  it('keeps the single UpdateBanner slot outside the pager and only the active page mounted at rest', async () => {
    await renderApp();
    expect(shellPager().parentElement).toBe(content());
    expect(shellPager().querySelector('[data-testid="update-banner"]')).toBeNull();
    expect(shellTabs()).toEqual(['anime']);
    await settled(shellPager, 'anime');
  });

  it('drags anime → manga with both pages side by side, then commits without remounting the peeked MangaPage', async () => {
    await renderApp();
    const p = page();
    down(p, 300);
    move(p, 240);
    expect(shellTabs()).toEqual(['anime', 'manga']);
    expect(shellSlide('anime').style.transform).toBe('translate3d(-60px, 0, 0)');
    expect(shellSlide('manga').style.transform).toBe('translate3d(calc(100% - 60px), 0, 0)');
    expect(shellSlide('manga')).toHaveAttribute('aria-hidden', 'true');
    expect(shellSlide('manga')).toHaveAttribute('inert');
    const peekedSlide = shellSlide('manga');
    const peekedPage = peekedSlide.firstElementChild;
    move(p, 150);
    expect(shellSlide('manga').style.transform).toBe('translate3d(calc(100% - 150px), 0, 0)');
    up(p, 150);
    expect(where()).toBe('manga');
    expect(shellSlide('anime').style.transform).toBe('translate3d(-100%, 0, 0)');
    expect(shellSlide('manga').style.transform).toBe('translate3d(0px, 0, 0)');
    expect(shellSlide('manga')).toBe(peekedSlide);
    await settled(shellPager, 'manga');
    expect(shellSlide('manga')).toBe(peekedSlide);
    expect(shellSlide('manga').firstElementChild).toBe(peekedPage); // same DOM: no remount, no scroll reset
  });

  it('reverses the revealed neighbour when the finger crosses its start point', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('manga'));
    await settled(shellPager, 'manga');
    const p = page();
    down(p, 300);
    move(p, 220);
    expect(shellTabs()).toEqual(['manga', 'downloads']);
    move(p, 390);
    expect(shellTabs()).toEqual(['anime', 'manga']);
    expect(shellSlide('anime').style.transform).toBe('translate3d(calc(-100% + 90px), 0, 0)');
    expect(shellSlide('manga').style.transform).toBe('translate3d(90px, 0, 0)');
    move(p, 320);
    up(p, 320); // below the threshold: both glide back
    expect(where()).toBe('manga');
    expect(shellSlide('manga').style.transform).toBe('translate3d(0px, 0, 0)');
    expect(shellSlide('anime').style.transform).toBe('translate3d(-100%, 0, 0)');
    await settled(shellPager, 'manga');
  });

  it('previews the Downloads entry sub-tab: tasks when peeked from Manga, manga when peeked from Settings', async () => {
    await renderApp();
    // The routed Downloads sub-tab is somewhere in the middle…
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'subtitles' }));
    act(() => useRouteStore.getState().setTab('manga'));
    await settled(shellPager, 'manga');

    let p = page();
    down(p, 300);
    move(p, 180); // drag left from Manga
    expect(shellTabs()).toEqual(['manga', 'downloads']);
    expect(dlPager().dataset['activeTab']).toBe('tasks');
    expect(tabsOf(dlPager())).toEqual(['tasks']);
    const peeked = shellSlide('downloads');
    up(p, 180);
    expect(where()).toBe('downloads/tasks'); // …the commit lands on the previewed sub-tab
    expect(shellSlide('downloads')).toBe(peeked);
    expect(tabsOf(dlPager())).toEqual(['tasks']); // no inner slide on entry
    await settled(shellPager, 'downloads');

    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'subtitles' }));
    act(() => useRouteStore.getState().setTab('settings'));
    await settled(shellPager, 'settings');
    p = page();
    down(p, 200);
    move(p, 320); // drag right from Settings
    expect(shellTabs()).toEqual(['downloads', 'settings']);
    expect(dlPager().dataset['activeTab']).toBe('manga');
    expect(shellSlide('downloads').style.transform).toBe('translate3d(calc(-100% + 120px), 0, 0)');
    // The peeked page is invisible to ARIA queries (no duplicate tab bars).
    expect(screen.queryByRole('tablist', { name: '下载' })).toBeNull();
    up(p, 320);
    expect(where()).toBe('downloads/manga');
    await settled(shellPager, 'downloads');
    expect(within(screen.getByRole('tablist', { name: '下载' })).getByRole('tab', { selected: true })).toHaveTextContent('漫画');
  });

  it('drags Downloads sub-tabs side by side and chains to the Shell pages at the Downloads edges', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'tasks' }));
    await settled(shellPager, 'downloads');
    const p = page();
    down(p, 300);
    move(p, 180); // left: tasks → anime inside Downloads
    expect(tabsOf(dlPager())).toEqual(['tasks', 'anime']);
    expect(slideOf(dlPager(), 'tasks').style.transform).toBe('translate3d(-120px, 0, 0)');
    expect(slideOf(dlPager(), 'anime').style.transform).toBe('translate3d(calc(100% - 120px), 0, 0)');
    expect(shellTabs()).toEqual(['downloads']);
    expect(shellSlide('downloads').style.transform).toBe('');
    move(p, 420); // right: tasks is Downloads' first sub-tab → the Shell reveals Manga
    expect(tabsOf(dlPager())).toEqual(['tasks']);
    expect(slideOf(dlPager(), 'tasks').style.transform).toBe('');
    expect(shellTabs()).toEqual(['manga', 'downloads']);
    expect(shellSlide('downloads').style.transform).toBe('translate3d(120px, 0, 0)');
    expect(shellSlide('manga').style.transform).toBe('translate3d(calc(-100% + 120px), 0, 0)');
    move(p, 180);
    up(p, 180);
    expect(where()).toBe('downloads/anime');
    expect(shellTabs()).toEqual(['downloads']);
    expect(slideOf(dlPager(), 'anime').style.transform).toBe('translate3d(0px, 0, 0)');
    expect(slideOf(dlPager(), 'tasks').style.transform).toBe('translate3d(-100%, 0, 0)');
    await settled(dlPager, 'anime');

    // At the last sub-tab a left drag reveals Settings next to Downloads.
    act(() => useRouteStore.getState().setDownloadsTab('manga'));
    await settled(dlPager, 'manga');
    const q = page();
    down(q, 300);
    move(q, 200);
    expect(tabsOf(dlPager())).toEqual(['manga']);
    expect(shellTabs()).toEqual(['downloads', 'settings']);
    expect(shellSlide('settings').style.transform).toBe('translate3d(calc(100% - 100px), 0, 0)');
    up(q, 200);
    expect(where()).toBe('settings');
    await settled(shellPager, 'settings');
  });

  it('drags the Nyaa Stage-2 pages side by side first, falling through to the Downloads sub-tabs at their edge', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'anime' }));
    await settled(shellPager, 'downloads');
    fireEvent.click((await screen.findAllByTestId('anime-series-card'))[0]!);
    await screen.findByTestId('series-detail-banner');
    const section = document.querySelector<HTMLElement>('.k-dl-search')!;
    down(section, 400);
    move(section, 300); // torrents → subtitles
    expect(tabsOf(nyaaPager())).toEqual(['torrents', 'subtitles']);
    expect(slideOf(nyaaPager(), 'torrents').style.transform).toBe('translate3d(-100px, 0, 0)');
    expect(slideOf(nyaaPager(), 'subtitles').style.transform).toBe('translate3d(calc(100% - 100px), 0, 0)');
    expect(tabsOf(dlPager())).toEqual(['anime']);
    move(section, 530); // torrents edge → Downloads anime → tasks
    expect(tabsOf(nyaaPager())).toEqual(['torrents']);
    expect(tabsOf(dlPager())).toEqual(['tasks', 'anime']);
    expect(slideOf(dlPager(), 'anime').style.transform).toBe('translate3d(130px, 0, 0)');
    expect(shellTabs()).toEqual(['downloads']);
    move(section, 250);
    up(section, 250);
    expect(section.dataset['detailTab']).toBe('subtitles');
    expect(where()).toBe('downloads/anime');
    expect(slideOf(nyaaPager(), 'subtitles').style.transform).toBe('translate3d(0px, 0, 0)');
    await settled(nyaaPager, 'subtitles');
    await settled(dlPager, 'anime');

    // Tapping the 视频种子 chip slides torrents back in from the left (a real tap starts
    // with a touchstart, which also lifts the post-swipe click guard).
    const chip = screen.getByRole('button', { name: /视频种子/ });
    down(chip, 300, 200);
    up(chip, 300, 200);
    fireEvent.click(chip);
    expect(section.dataset['detailTab']).toBe('torrents');
    expect(tabsOf(nyaaPager())).toEqual(['torrents', 'subtitles']);
    expect(slideOf(nyaaPager(), 'subtitles').style.transform).toBe('translate3d(100%, 0, 0)');
    await settled(nyaaPager, 'torrents');
  });

  it('rubber-bands the single Shell page at the outermost destinations and glides back', async () => {
    await renderApp();
    const p = page();
    down(p, 200);
    move(p, 300);
    expect(shellTabs()).toEqual(['anime']);
    expect(shellSlide('anime').style.transform).toBe('translate3d(20px, 0, 0)');
    move(p, 700);
    expect(shellSlide('anime').style.transform).toBe('translate3d(36px, 0, 0)');
    up(p, 700);
    expect(where()).toBe('anime');
    expect(shellSlide('anime').style.transform).toBe('translate3d(0px, 0, 0)');
    await settled(shellPager, 'anime');

    act(() => useRouteStore.getState().setTab('settings'));
    await settled(shellPager, 'settings');
    const s = page();
    down(s, 600);
    move(s, 450);
    expect(shellTabs()).toEqual(['settings']);
    expect(shellSlide('settings').style.transform).toBe('translate3d(-30px, 0, 0)');
    fireEvent.touchCancel(s);
    expect(where()).toBe('settings');
    await settled(shellPager, 'settings');
  });

  it('slides old and new destination side by side on NavBar taps, skipping the pages in between', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(where()).toBe('settings');
    expect(shellTabs()).toEqual(['anime', 'settings']); // never manga / downloads
    expect(shellSlide('anime').style.transform).toBe('translate3d(-100%, 0, 0)');
    expect(shellSlide('settings').style.transform).toBe('translate3d(0px, 0, 0)');
    expect(shellSlide('anime')).toHaveAttribute('inert');
    // Retarget mid-flight: Downloads replaces Settings' entry, the old Anime slide is gone.
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(shellTabs()).toEqual(['downloads', 'settings']);
    expect(shellSlide('settings').style.transform).toBe('translate3d(100%, 0, 0)');
    expect(shellSlide('downloads').style.transform).toBe('translate3d(0px, 0, 0)');
    await settled(shellPager, 'downloads');

    const tabs = within(screen.getByRole('tablist', { name: '下载' })).getAllByRole('tab');
    fireEvent.click(tabs[2]!); // tasks → subtitles
    expect(where()).toBe('downloads/subtitles');
    expect(tabsOf(dlPager())).toEqual(['tasks', 'subtitles']);
    expect(slideOf(dlPager(), 'tasks').style.transform).toBe('translate3d(-100%, 0, 0)');
    await settled(dlPager, 'subtitles');
    fireEvent.click(tabs[0]!);
    expect(slideOf(dlPager(), 'subtitles').style.transform).toBe('translate3d(100%, 0, 0)');
    await settled(dlPager, 'tasks');
  });

  it('never peeks the player, drops all motion on entering it and leaves no transformed ancestor', async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId('series-series-kotori'));
    fireEvent.click(await screen.findByText('放課後の本屋'));
    const player = await screen.findByTestId('player');
    expect(shellTabs()).toEqual(['anime']);
    expectNoTransformedAncestor(player);

    // Leave the player for Manga (it stays the Anime destination's view), then swipe back onto it.
    act(() => useRouteStore.getState().setTab('manga'));
    expect(shellTabs()).toEqual(['manga']); // leaving the player is not animated
    const p = page();
    down(p, 200);
    move(p, 330);
    expect(shellTabs()).toEqual(['manga']); // the player is never mounted as a peek
    expect(shellSlide('manga').style.transform).toBe('translate3d(130px, 0, 0)');
    up(p, 420);
    expect(where()).toBe('anime');
    expect(useRouteStore.getState().anime.kind).toBe('player');
    expect(shellTabs()).toEqual(['anime']);
    expectNoTransformedAncestor(await screen.findByTestId('player'));
  });

  it('opening the player mid-slide aborts the slide at once', async () => {
    await renderApp();
    act(() => useRouteStore.getState().setTab('manga'));
    await settled(shellPager, 'manga');
    fireEvent.click(screen.getByRole('button', { name: '动画' }));
    expect(shellTabs()).toEqual(['anime', 'manga']);
    act(() => useRouteStore.getState().openAnime({ kind: 'player', seriesId: 'series-kotori', episodeId: 'series-kotori-ep1' }));
    expect(shellTabs()).toEqual(['anime']);
    expect(shellSlide('anime').getAttribute('style') ?? '').toBe('');
    expect(shellPager()).not.toHaveAttribute('data-pager-moving');
    expectNoTransformedAncestor(await screen.findByTestId('player'));
  });
});
