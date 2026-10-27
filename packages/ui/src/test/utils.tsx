/** Shared test helpers: render inside a HostProvider with a zero-latency mock host and fresh stores. */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useRouteStore } from '../app/routes';
import { useAnimeStore } from '../features/anime/useAnimeStore';
import { useUpdateStore } from '../features/updater/updater';
import { HostProvider } from '../host/HostContext';
import { createMockPlatformHost, type MockHostOptions, type MockPlatformHost } from '../host/mock-host';
import { useBreakdownStore } from '../stores/breakdown';
import { useSettingsStore } from '../stores/settings';
import { useSnackbarStore } from '../stores/snackbar';

export function resetStores(): void {
  useBreakdownStore.getState().reset();
  useSettingsStore.getState().reset();
  useRouteStore.getState().reset();
  useSnackbarStore.getState().reset();
  useAnimeStore.getState().reset();
  useUpdateStore.getState().reset();
}

export function renderWithHost(ui: ReactElement, options: MockHostOptions = {}): RenderResult & { host: MockPlatformHost } {
  const host = createMockPlatformHost({ latencyMs: 0, streamDelayMs: 0, ...options });
  const result = render(<HostProvider host={host}>{ui}</HostProvider>);
  return Object.assign(result, { host });
}

/** Glyph span for a UTF-16 index inside a container. */
export function glyphAt(container: HTMLElement, index: number): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-glyph][data-char-start="${index}"]`);
  if (!el) throw new Error(`no glyph at ${index}`);
  return el;
}
