import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useRouteStore } from '../../app/routes';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost } from '../../host/mock-host';
import { useBreakdownStore } from '../../stores/breakdown';
import { useSettingsStore } from '../../stores/settings';
import { MangaPage } from './MangaPage';

// jsdom never loads images: fire `load` asynchronously so crop/downscale proceed.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get(this: HTMLImageElement) {
      return this.getAttribute('src') ?? '';
    },
    set(this: HTMLImageElement, v: string) {
      this.setAttribute('src', v);
      setTimeout(() => this.onload?.(new Event('load')), 0);
    },
  });
});

beforeEach(() => {
  useBreakdownStore.getState().reset();
  useSettingsStore.getState().reset();
  useRouteStore.getState().reset();
});
afterEach(cleanup);

function setup() {
  const host = createMockPlatformHost({ latencyMs: 0 });
  render(
    <HostProvider host={host}>
      <MangaPage />
    </HostProvider>,
  );
  return host;
}

describe('MangaPage', () => {
  it('lists volumes with OCR / raw badges and opens the reader', async () => {
    setup();
    const ocr = await screen.findByTestId('volume-vol-houkago-1');
    expect(within(ocr).getByText('OCR')).toBeInTheDocument();
    expect(within(screen.getByTestId('volume-vol-hoshikuzu-raw-1')).getByText('无 OCR')).toBeInTheDocument();
    fireEvent.click(ocr);
    expect(useRouteStore.getState().manga).toEqual({ kind: 'reader', volumeId: 'vol-houkago-1' });
    expect(await screen.findByTestId('manga-reader')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(useRouteStore.getState().manga).toEqual({ kind: 'library' });
  });

  it('refreshes on library-changed after an import', async () => {
    const host = setup();
    await screen.findByTestId('volume-vol-houkago-1');
    const v = await host.manga.importVolume({ path: '/home/kotori/Manga/夏空ダイアリー 第1巻.mokuro' });
    expect(await screen.findByTestId(`volume-${v.id}`)).toBeInTheDocument();
  });

  it('✨ page guide lists bubbles and picking one opens the breakdown on its block', async () => {
    const host = setup();
    fireEvent.click(await screen.findByTestId('volume-vol-houkago-1'));
    await waitFor(() => expect(screen.getByTestId('spread').dataset['pageIndexes']).toBe('1,2'));
    fireEvent.click(screen.getByTestId('guide-toggle'));
    const item = await screen.findByTestId('guide-item-1-1');
    expect(host.calls.get('ai.pageGuide')).toBe(2); // both pages of the spread
    fireEvent.click(item);
    const s = useBreakdownStore.getState();
    expect(s.request?.source).toMatchObject({ kind: 'manga', pageIndex: 1, blockIndex: 0 });
    expect(s.request?.sentence).toBe('おはよう、ことり。');
  });
});
