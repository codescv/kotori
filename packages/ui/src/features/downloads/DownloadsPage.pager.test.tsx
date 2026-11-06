/**
 * DownloadsPage sub-tab `<TabPager>`: `previewTab` override (the Shell's peek of the
 * Downloads entry sub-tab), dual-page sub-tab drag, and inactive-slide isolation
 * (`useBackInterceptor` / `Dialog` stay silent inside a peeked or exiting slide).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchBackNavigation, useBackInterceptor, useRouteStore } from '../../app/routes';
import { Dialog } from '../../components/m3/Dialog';
import { InactiveTabSlideContext } from '../../components/m3/tabSlideContext';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../host/mock-host';
import { installPointerEventPolyfill } from '../../test/pointer';
import { resetStores } from '../../test/utils';
import { DownloadsPage } from './DownloadsPage';

const panel = (): HTMLElement => screen.getByTestId('downloads-tabpanel');
const slideTabs = (): string[] =>
  [...panel().children]
    .filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('k-pager__slide'))
    .map((el) => el.dataset['pagerTab']!);

let host: MockPlatformHost;

function renderPage(ui: ReactNode): void {
  host = createMockPlatformHost({ latencyMs: 0 });
  render(<HostProvider host={host}>{ui}</HostProvider>);
}

describe('DownloadsPage pager', () => {
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
  });

  it('shows previewTab instead of the routed sub-tab and returns to the routed one without it', async () => {
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'subtitles' }));
    renderPage(<DownloadsPage previewTab="manga" />);
    expect(panel().dataset['activeTab']).toBe('manga');
    expect(slideTabs()).toEqual(['manga']);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('漫画');
    cleanup();
    renderPage(<DownloadsPage />);
    expect(panel().dataset['activeTab']).toBe('subtitles');
    await screen.findByRole('tab', { selected: true });
  });

  it('drags the adjacent sub-tab in side by side and commits to it', async () => {
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'anime' }));
    renderPage(<DownloadsPage />);
    const pageEl = document.querySelector<HTMLElement>('.k-downloads')!;
    fireEvent.touchStart(pageEl, { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.touchMove(pageEl, { touches: [{ clientX: 390, clientY: 300 }] });
    expect(slideTabs()).toEqual(['tasks', 'anime']);
    fireEvent.touchMove(pageEl, { touches: [{ clientX: 200, clientY: 300 }] });
    expect(slideTabs()).toEqual(['anime', 'subtitles']);
    fireEvent.touchEnd(pageEl, { touches: [], changedTouches: [{ clientX: 200, clientY: 300 }] });
    expect(useRouteStore.getState().downloadsTab).toBe('subtitles');
    expect(slideTabs()).toEqual(['anime', 'subtitles']);
    await screen.findByRole('tab', { selected: true });
  });

  it('inside an inactive slide: no nested swipe, no back interceptor, no dialog', () => {
    const backs: string[] = [];
    function Probe({ name }: { name: string }) {
      useBackInterceptor(() => {
        backs.push(name);
        return true;
      });
      return (
        <Dialog open onClose={() => {}} title={`dialog-${name}`}>
          <input data-autofocus aria-label={`field-${name}`} />
        </Dialog>
      );
    }
    act(() => useRouteStore.getState().setTab('downloads', { downloadsTab: 'tasks' }));
    renderPage(
      <>
        <Probe name="visible" />
        <InactiveTabSlideContext.Provider value>
          <Probe name="peeked" />
          <DownloadsPage previewTab="anime" />
        </InactiveTabSlideContext.Provider>
      </>,
    );
    expect(screen.getByText('dialog-visible')).toBeInTheDocument();
    expect(screen.queryByText('dialog-peeked')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('field-visible'));
    act(() => {
      dispatchBackNavigation();
    });
    expect(backs).toEqual(['visible']);

    const pageEl = document.querySelector<HTMLElement>('.k-downloads')!;
    fireEvent.touchStart(pageEl, { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.touchMove(pageEl, { touches: [{ clientX: 150, clientY: 300 }] });
    fireEvent.touchEnd(pageEl, { touches: [], changedTouches: [{ clientX: 150, clientY: 300 }] });
    expect(slideTabs()).toEqual(['anime']);
    expect(useRouteStore.getState().downloadsTab).toBe('tasks');
  });
});
