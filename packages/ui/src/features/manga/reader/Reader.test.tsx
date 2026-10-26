import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostProvider } from '../../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../../host/mock-host';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { Reader } from './Reader';

const VOL = 'vol-houkago-1';

function setup(host: MockPlatformHost = createMockPlatformHost({ latencyMs: 0 }), volumeId = VOL) {
  render(
    <HostProvider host={host}>
      <Reader volumeId={volumeId} onExit={() => {}} />
    </HostProvider>,
  );
  return host;
}

const spread = (): HTMLElement => screen.getByTestId('spread');
const slotPage = (side: 'left' | 'right'): string | null | undefined =>
  spread().querySelector(`[data-slot="${side}"] [data-page-index]`)?.getAttribute('data-page-index');
const key = (k: string): void => {
  act(() => {
    fireEvent.keyDown(window, { key: k });
  });
};

beforeEach(() => {
  useBreakdownStore.getState().reset();
  useSettingsStore.getState().reset();
});
afterEach(cleanup);

describe('Reader — spread-rtl navigation', () => {
  it('opens at the saved page with page 1 in the RIGHT slot, and navigates RTL with the arrow keys', async () => {
    setup();
    // Saved progress is page 1 → spread [1,2].
    await waitFor(() => expect(spread().dataset['pageIndexes']).toBe('1,2'));
    expect(slotPage('right')).toBe('1');
    expect(slotPage('left')).toBe('2');

    // ArrowRight goes back (RTL): the cover sits alone in the right slot.
    key('ArrowRight');
    expect(spread().dataset['pageIndexes']).toBe('0');
    expect(slotPage('right')).toBe('0');
    expect(spread().querySelector('[data-slot="left"]')).toHaveClass('is-blank');

    // ArrowLeft advances.
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('1,2');
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('3,4');
    expect(slotPage('right')).toBe('3');

    // Page 5 is a wide double page → alone, without a blank partner.
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('5');
    expect(spread().querySelectorAll('[data-slot]')).toHaveLength(1);
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('6,7');
  });

  it('edge buttons follow the reading direction', async () => {
    setup();
    await waitFor(() => expect(spread().dataset['pageIndexes']).toBe('1,2'));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(spread().dataset['pageIndexes']).toBe('3,4');
    expect(screen.getByRole('button', { name: '下一页' }).className).toContain('k-reader__edge--left');
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(spread().dataset['pageIndexes']).toBe('1,2');
  });

  it('cover-offset toggle regroups spreads and keeps the current page', async () => {
    const host = setup();
    await waitFor(() => expect(spread().dataset['pageIndexes']).toBe('1,2'));
    key('ArrowLeft');
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('5');

    fireEvent.click(screen.getByTestId('cover-toggle'));
    await waitFor(() => expect(screen.getByTestId('cover-toggle')).toHaveAttribute('aria-pressed', 'false'));
    expect((await host.manga.getVolume(VOL)).coverIsSingle).toBe(false);
    expect(spread().dataset['pageIndexes']).toBe('5');

    key('Home');
    expect(spread().dataset['pageIndexes']).toBe('0,1');
    expect(slotPage('right')).toBe('0');
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('2,3');
    key('ArrowLeft');
    // Page 4 precedes the wide page 5, so it sits alone.
    expect(spread().dataset['pageIndexes']).toBe('4');
  });

  it('saves progress after a page turn', async () => {
    const host = setup();
    await waitFor(() => expect(spread().dataset['pageIndexes']).toBe('1,2'));
    expect(host.calls.get('manga.saveProgress') ?? 0).toBe(0); // restoring is not a save
    key('ArrowLeft');
    await waitFor(() => expect(host.calls.get('manga.saveProgress')).toBe(1), { timeout: 3000 });
    expect((await host.manga.getVolume(VOL)).progress?.pageIndex).toBe(3);
  });
});

describe('Reader — other modes', () => {
  it('spread-ltr: ArrowRight advances and page 1 is on the LEFT', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    await host.manga.setReadingMode(VOL, 'spread-ltr');
    setup(host);
    await waitFor(() => expect(spread().dataset['pageIndexes']).toBe('1,2'));
    expect(slotPage('left')).toBe('1');
    expect(slotPage('right')).toBe('2');
    key('ArrowRight');
    expect(spread().dataset['pageIndexes']).toBe('3,4');
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('1,2');
  });

  it('single-rtl raw volume: one page per view and the bubble select tool can be toggled', async () => {
    setup(createMockPlatformHost({ latencyMs: 0 }), 'vol-hoshikuzu-raw-1');
    await waitFor(() => expect(spread().dataset['pageIndexes']).toBe('0'));
    key('ArrowLeft');
    expect(spread().dataset['pageIndexes']).toBe('1');
    expect(screen.queryByTestId('block-overlay-1')).toBeNull();
    fireEvent.click(screen.getByTestId('select-toggle'));
    expect(screen.getByTestId('select-tool-1')).toBeInTheDocument();
  });

  it('switches mode from the menu and persists it per volume', async () => {
    const host = setup();
    await waitFor(() => expect(spread().dataset['pageIndexes']).toBe('1,2'));
    fireEvent.click(screen.getByRole('button', { name: '阅读模式' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /单页（右→左）/ }));
    await waitFor(() => expect(screen.getByTestId('manga-reader').dataset['mode']).toBe('single-rtl'));
    expect(spread().dataset['pageIndexes']).toBe('1');
    expect((await host.manga.getVolume(VOL)).readingMode).toBe('single-rtl');
  });
});
