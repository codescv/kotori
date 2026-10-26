import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MangaPage } from '@kotori/core';
import { HostProvider } from '../../../host/HostContext';
import { createMockPlatformHost } from '../../../host/mock-host';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { BubbleSelectTool } from './BubbleSelectTool';

const VOL = 'vol-hoshikuzu-raw-1';

beforeAll(() => {
  // jsdom: no PointerEvent, no image loading, no canvas.
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  }
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
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  useBreakdownStore.getState().reset();
  useSettingsStore.getState().reset();
});
afterEach(cleanup);

describe('BubbleSelectTool', () => {
  it('drag-select → ocrBubble({explain:true}) → breakdown → save as vlm block', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const page = (await host.manga.getPages(VOL))[3] as MangaPage;
    expect(page.blocks).toHaveLength(0);
    const ocr = vi.spyOn(host.ai, 'ocrBubble');
    const onPageUpdated = vi.fn();
    render(
      <HostProvider host={host}>
        <BubbleSelectTool volumeId={VOL} page={page} onPageUpdated={onPageUpdated} />
      </HostProvider>,
    );
    const tool = screen.getByTestId('select-tool-3');
    tool.getBoundingClientRect = () => ({ left: 0, top: 0, width: page.width, height: page.height, right: page.width, bottom: page.height, x: 0, y: 0, toJSON: () => ({}) });

    // Drag over the 「行かなきゃ」 bubble (page px == client px here), bottom-right → top-left.
    fireEvent.pointerDown(tool, { clientX: 1070, clientY: 370, button: 0, pointerId: 1 });
    fireEvent.pointerMove(tool, { clientX: 990, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(tool, { clientX: 980, clientY: 100, pointerId: 1 });

    await waitFor(() => expect(ocr).toHaveBeenCalledTimes(1));
    const req = ocr.mock.calls[0]![0];
    expect(req).toMatchObject({ volumeId: VOL, pageIndex: 3, explain: true, rect: { left: 980, top: 100, right: 1070, bottom: 370 } });
    expect(req.image.mimeType).toBe('image/jpeg');

    await waitFor(() => expect(useBreakdownStore.getState().explanation?.sentence).toBe('行かなきゃ'));
    const s = useBreakdownStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.request?.source).toEqual({ kind: 'manga', volumeId: VOL, pageIndex: 3 });
    expect(await screen.findByText('行かなきゃ')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存为文本块' }));
    await waitFor(() => expect(onPageUpdated).toHaveBeenCalledTimes(1));
    const updated = onPageUpdated.mock.calls[0]![0] as MangaPage;
    expect(updated.blocks).toHaveLength(1);
    expect(updated.blocks[0]).toMatchObject({ index: 0, source: 'vlm', text: '行かなきゃ', vertical: true });
  });

  it('ignores tiny accidental drags', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const page = (await host.manga.getPages(VOL))[1] as MangaPage;
    const ocr = vi.spyOn(host.ai, 'ocrBubble');
    render(
      <HostProvider host={host}>
        <BubbleSelectTool volumeId={VOL} page={page} onPageUpdated={() => {}} />
      </HostProvider>,
    );
    const tool = screen.getByTestId('select-tool-1');
    tool.getBoundingClientRect = () => ({ left: 0, top: 0, width: page.width, height: page.height, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(tool, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(tool, { clientX: 104, clientY: 103 });
    await new Promise((r) => setTimeout(r, 10));
    expect(ocr).not.toHaveBeenCalled();
  });
});
