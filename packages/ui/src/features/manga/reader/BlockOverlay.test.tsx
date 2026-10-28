import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MangaPage } from '@kotori/core';
import { HostProvider } from '../../../host/HostContext';
import { createMockPlatformHost } from '../../../host/mock-host';
import { charIndexAt, deriveCharRegions } from '../../../lib/manga';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { BlockOverlay, blockContext, blocksInReadingOrder } from './BlockOverlay';

const VOL = 'vol-houkago-1';

async function setup(pageIndex = 3) {
  const host = createMockPlatformHost({ latencyMs: 0 });
  const page = (await host.manga.getPages(VOL))[pageIndex] as MangaPage;
  const utils = render(
    <HostProvider host={host}>
      <BlockOverlay volumeId={VOL} page={page} showOutlines />
    </HostProvider>,
  );
  const cell = (block: number, i: number): Element => {
    const el = utils.container.querySelector(`[data-block-index="${block}"] [data-char-start="${i}"]`);
    if (!el) throw new Error(`cell ${block}/${i} missing`);
    return el;
  };
  return { host, page, cell, ...utils };
}

beforeEach(() => {
  useBreakdownStore.getState().reset();
  useSettingsStore.getState().reset();
});
afterEach(cleanup);

describe('BlockOverlay', () => {
  it('renders one hit cell per character with UTF-16 offsets', async () => {
    const { page, container } = await setup();
    const block = page.blocks[0]!;
    expect(block.text).toBe('食べてんじゃねぇよ！');
    const starts = [...container.querySelectorAll('[data-block-index="0"] [data-char-start]')].map((e) => Number(e.getAttribute('data-char-start')));
    expect(starts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('click on a char opens the breakdown with block.text + exact focusCharIndex; same-block clicks are network-free', async () => {
    const { host, page, cell } = await setup();
    const block = page.blocks[0]!;

    fireEvent.click(cell(0, 2));
    let s = useBreakdownStore.getState();
    expect(s.request?.sentence).toBe(block.text);
    expect(s.focusCharIndex).toBe(2);
    expect(s.request?.source).toEqual({ kind: 'manga', volumeId: VOL, pageIndex: 3, blockIndex: 0 });
    expect(s.request?.contextAfter).toEqual([page.blocks[1]!.text]);

    await waitFor(() => expect(useBreakdownStore.getState().status).toBe('ready'));
    expect(host.calls.get('ai.explain')).toBe(1);

    // Focused chunk てんじゃねぇ = [2, 8) is painted on the bubble.
    for (let i = 2; i < 8; i++) expect(cell(0, i)).toHaveClass('is-hl');
    expect(cell(0, 0)).not.toHaveClass('is-hl');
    expect(cell(0, 8)).not.toHaveClass('is-hl');
    expect(cell(0, 2)).toHaveClass('is-focus');

    // Second click on the same bubble → focus only (0 latency, no ai.explain).
    fireEvent.click(cell(0, 0));
    s = useBreakdownStore.getState();
    expect(s.focusCharIndex).toBe(0);
    expect(s.status).toBe('ready');
    expect(host.calls.get('ai.explain')).toBe(1);
    expect(cell(0, 0)).toHaveClass('is-hl');
    expect(cell(0, 1)).toHaveClass('is-hl');
    expect(cell(0, 2)).not.toHaveClass('is-hl');

    // Reverse highlight: focusing a chunk from the panel repaints the bubble.
    act(() => useBreakdownStore.getState().setFocus(8));
    expect(cell(0, 8)).toHaveClass('is-hl');
    expect(cell(0, 0)).not.toHaveClass('is-hl');

    // A different bubble is a new sentence → one more model call.
    fireEvent.click(cell(1, 0));
    expect(useBreakdownStore.getState().request?.sentence).toBe(page.blocks[1]!.text);
    await waitFor(() => expect(useBreakdownStore.getState().status).toBe('ready'));
    expect(host.calls.get('ai.explain')).toBe(2);
    expect(cell(0, 2)).not.toHaveClass('is-hl');
  });

  it('click on bubble padding maps geometrically through clientToPage + charIndexAt', async () => {
    const { page, container } = await setup();
    const block = page.blocks[0]!;
    const svg = container.querySelector('svg') as SVGSVGElement;
    // Render the page at half size, offset by (10, 20).
    svg.getBoundingClientRect = () => ({ left: 10, top: 20, width: page.width / 2, height: page.height / 2, right: 0, bottom: 0, x: 10, y: 20, toJSON: () => ({}) });
    const region = deriveCharRegions(block)[5]!;
    const px = (region.rect.left + region.rect.right) / 2;
    const py = (region.rect.top + region.rect.bottom) / 2;
    expect(charIndexAt(block, px, py)).toBe(5);
    const hit = container.querySelector('[data-block-index="0"] .k-block__hit')!;
    fireEvent.click(hit, { clientX: 10 + px / 2, clientY: 20 + py / 2 });
    expect(useBreakdownStore.getState().focusCharIndex).toBe(5);
    expect(useBreakdownStore.getState().request?.sentence).toBe(block.text);
  });

  it('keyboard Enter opens the bubble at its first character', async () => {
    const { page, container } = await setup(2);
    const g = container.querySelector('[data-block-index="1"]')!;
    fireEvent.keyDown(g, { key: 'Enter' });
    const s = useBreakdownStore.getState();
    expect(s.request?.sentence).toBe(page.blocks[1]!.text);
    expect(s.focusCharIndex).toBe(0);
    expect(s.request?.contextBefore).toEqual([page.blocks[0]!.text]);
  });

  it('blockContext returns up to 3 preceding and 2 following bubble texts', async () => {
    const { page } = await setup(2);
    expect(blockContext(page, 0)).toEqual({ contextBefore: [], contextAfter: [page.blocks[1]!.text, page.blocks[2]!.text] });
    expect(blockContext(page, 2).contextBefore).toEqual([page.blocks[0]!.text, page.blocks[1]!.text]);
  });

  it('blockContext follows RTL geometric reading order (top-right → bottom-left), not OCR array order', async () => {
    const { page } = await setup(2);
    // Shuffle the OCR array: bottom bubble first, then left, then right.
    const [right, left, bottom] = page.blocks as [MangaPage['blocks'][number], MangaPage['blocks'][number], MangaPage['blocks'][number]];
    const shuffled: MangaPage = { ...page, blocks: [bottom, left, right] };
    expect(blocksInReadingOrder(shuffled).map((b) => b.text)).toEqual([right.text, left.text, bottom.text]);
    expect(blockContext(shuffled, right.index)).toEqual({ contextBefore: [], contextAfter: [left.text, bottom.text] });
    expect(blockContext(shuffled, bottom.index)).toEqual({ contextBefore: [right.text, left.text], contextAfter: [] });
  });
});
