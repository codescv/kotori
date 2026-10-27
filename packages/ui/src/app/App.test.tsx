import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatformHost } from '../host/mock-host';
import { resetStores } from '../test/utils';
import { App } from './App';

/** Emulate a viewport width for `matchMedia('(min-width: Npx)')` queries. */
function setViewport(width: number, dark = true): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = min ? width >= Number(min[1]) : query.includes('prefers-color-scheme: dark') ? dark : false;
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  });
}

describe('App shell', () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['phone 360×800 → bottom navigation bar', 360, 'k-nav-bar'],
    ['desktop 1440×900 → navigation rail', 1440, 'k-nav-rail'],
  ])('%s; all four tabs navigable', async (_label, width, navClass) => {
    setViewport(width);
    const host = createMockPlatformHost({ latencyMs: 0 });
    const { container } = render(<App host={host} />);
    expect(container.querySelector(`.${navClass}`)).not.toBeNull();
    expect(await screen.findByTestId('series-series-kotori')).toBeInTheDocument();
    for (const [tab, marker] of [
      ['漫画', 'manga'],
      ['下载', 'downloads'],
      ['设置', 'settings'],
      ['动画', 'anime'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: tab }));
      expect(container.querySelector('.k-shell__content')?.getAttribute('data-tab')).toBe(marker);
    }
    await act(async () => {
      await host.dispose();
    });
  });

  it('applies M3 tokens from the seed colour and follows theme changes', async () => {
    setViewport(1440, true);
    const host = createMockPlatformHost({ latencyMs: 0 });
    render(<App host={host} />);
    await screen.findByTestId('series-series-kotori');
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe('dark');
    const darkSurface = root.style.getPropertyValue('--md-sys-color-surface');
    expect(darkSurface).toMatch(/^#/);
    await act(async () => {
      await host.settings.update({ ui: { theme: 'light' } });
    });
    await waitFor(() => expect(root.dataset['theme']).toBe('light'));
    expect(root.style.getPropertyValue('--md-sys-color-surface')).not.toBe(darkSurface);
  });

  it('opens a series and an episode from the library', async () => {
    setViewport(1440);
    const host = createMockPlatformHost({ latencyMs: 0 });
    render(<App host={host} />);
    fireEvent.click(await screen.findByTestId('series-series-kotori'));
    fireEvent.click(await screen.findByText('放課後の本屋'));
    expect(await screen.findByTestId('player')).toBeInTheDocument();
    expect(await screen.findAllByTestId('transcript-row')).not.toHaveLength(0);
  });

  it('opens AI assistant persona dialog when clicking the top-left brand icon and updates avatar', async () => {
    setViewport(1440);
    const host = createMockPlatformHost({ latencyMs: 0 });
    render(<App host={host} />);
    await screen.findByTestId('series-series-kotori');
    const trigger = screen.getByTestId('brand-persona-trigger');
    expect(trigger).toHaveTextContent('こ');
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('AI 助手形态设置');

    fireEvent.change(screen.getByLabelText('助手昵称'), { target: { value: '千束' } });
    fireEvent.change(screen.getByLabelText('助手图片（图片 URL 或 Data URL）'), {
      target: { value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
    });
    fireEvent.change(screen.getByLabelText('助手灵魂（Soul / 人设）'), {
      target: { value: '元気满满的锦木千束，用轻快亲切的语气回答追问！' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const s = await host.settings.get();
      expect(s.ai.persona).toEqual({
        name: '千束',
        avatarUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        soul: '元気满满的锦木千束，用轻快亲切的语气回答追问！',
      });
    });
    expect(trigger.querySelector('img')).not.toBeNull();
  });

  it('renders the AI assistant brand icon in compact (Android / phone) headers and opens the persona dialog', async () => {
    setViewport(360);
    const host = createMockPlatformHost({ latencyMs: 0 });
    render(<App host={host} />);
    await screen.findByTestId('series-series-kotori');
    const trigger = screen.getByTestId('brand-persona-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('こ');
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('AI 助手形态设置');
    await act(async () => {
      await host.dispose();
    });
  });
});
