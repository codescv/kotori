/**
 * `.mokuro` OCR blocks as clickable hit areas over a page.
 *
 * A click on a bubble resolves the exact UTF-16 `charIndex` — directly from the
 * per-character cell (`data-char-start`, cells from `deriveCharRegions`) or,
 * for clicks on bubble padding, geometrically via `clientToPage` +
 * `charIndexAt` — and opens the breakdown with `sentence = block.text`
 * (ARCHITECTURE §6.2). Re-clicking the same bubble only moves the focus (no
 * network). The focused chunk's cells are painted on the bubble, so the
 * sentence ⇄ chunk highlight is visible on the page as well.
 */
import { memo, useMemo, useRef, type KeyboardEvent, type MouseEvent, type TouchEvent } from 'react';
import type { CharSpan, MangaBlock, MangaPage } from '@kotori/core';
import { deriveSelection } from '../../../components/breakdown/useBreakdownSelection';
import { cx } from '../../../components/m3/cx';
import { useHost } from '../../../host/HostContext';
import { charIndexAt, clientToPage, deriveCharRegions } from '../../../lib/manga';
import { useBreakdownStore } from '../../../stores/breakdown';

export interface BlockOverlayProps {
  readonly volumeId: string;
  readonly page: MangaPage;
  /** Always draw block outlines (otherwise only on hover / when active). */
  readonly showOutlines: boolean;
  readonly sceneHint?: string | undefined;
}

/** Neighbouring bubble texts used as prompt context (reading order = block order). */
export function blockContext(page: MangaPage, blockIndex: number): { contextBefore: string[]; contextAfter: string[] } {
  const i = page.blocks.findIndex((b) => b.index === blockIndex);
  return {
    contextBefore: page.blocks.slice(Math.max(0, i - 3), Math.max(0, i)).map((b) => b.text),
    contextAfter: i < 0 ? [] : page.blocks.slice(i + 1, i + 3).map((b) => b.text),
  };
}

const attrInt = (el: Element | null, name: string): number | undefined => {
  const v = el?.getAttribute(name);
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

interface BlockShapeProps {
  readonly block: MangaBlock;
  readonly active: boolean;
  readonly highlight: CharSpan | undefined;
  readonly focusIndex: number | undefined;
  readonly showOutlines: boolean;
  readonly onPick: (block: MangaBlock, charIndex: number) => void;
}

const BlockShape = memo(function BlockShape({ block, active, highlight, focusIndex, showOutlines, onPick }: BlockShapeProps) {
  const regions = useMemo(() => deriveCharRegions(block), [block]);
  const { rect } = block;
  const pad = Math.max(6, block.fontSize * 0.25);
  const touchStartRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const lastTouchPickRef = useRef(0);

  const pickAtPoint = (target: Element, clientX: number, clientY: number): void => {
    const direct = attrInt(target.closest('[data-char-start]'), 'data-char-start');
    if (direct !== undefined) {
      onPick(block, direct);
      return;
    }
    const svg = target.closest('svg');
    const box = svg?.getBoundingClientRect();
    const vb = (svg?.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    const vbW = vb[2];
    const vbH = vb[3];
    if (!box || box.width === 0 || !vbW || !vbH) {
      onPick(block, 0);
      return;
    }
    const { x, y } = clientToPage(clientX, clientY, box, vbW, vbH);
    onPick(block, charIndexAt(block, x, y));
  };

  const onClick = (e: MouseEvent<SVGGElement>): void => {
    e.stopPropagation();
    if (Date.now() - lastTouchPickRef.current < 450) return;
    pickAtPoint(e.target as Element, e.clientX, e.clientY);
  };
  const onTouchStart = (e: TouchEvent<SVGGElement>): void => {
    if (e.touches.length === 1) {
      const t = e.touches[0]!;
      touchStartRef.current = { x: t.clientX, y: t.clientY };
    } else {
      touchStartRef.current = null;
    }
  };
  const onTouchMove = (e: TouchEvent<SVGGElement>): void => {
    const start = touchStartRef.current;
    if (!start || e.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const t = e.touches[0]!;
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) {
      touchStartRef.current = null;
    }
  };
  const onTouchEnd = (e: TouchEvent<SVGGElement>): void => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || e.changedTouches.length !== 1 || e.touches.length > 0) return;
    const t = e.changedTouches[0]!;
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) return;
    lastTouchPickRef.current = Date.now();
    const hitEl = (typeof document !== 'undefined' ? document.elementFromPoint(t.clientX, t.clientY) : null) ?? (e.target as Element);
    pickAtPoint(hitEl, t.clientX, t.clientY);
  };
  const onKey = (e: KeyboardEvent<SVGGElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(block, 0);
    }
  };

  return (
    <g
      className={cx('k-block', active && 'is-active', showOutlines && 'show-outline', block.source !== 'mokuro' && `k-block--${block.source}`)}
      data-block-index={block.index}
      role="button"
      tabIndex={0}
      aria-label={block.text}
      onClick={onClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onKeyDown={onKey}
    >
      <rect
        className="k-block__hit"
        x={rect.left - pad}
        y={rect.top - pad}
        width={rect.right - rect.left + pad * 2}
        height={rect.bottom - rect.top + pad * 2}
        rx={pad * 1.5}
      />
      {regions.map((r) => {
        const hl = highlight !== undefined && r.utf16Start >= highlight[0] && r.utf16Start < highlight[1];
        const focus = focusIndex !== undefined && focusIndex >= r.utf16Start && focusIndex < r.utf16End;
        return (
          <rect
            key={r.utf16Start}
            className={cx('k-block__cell', hl && 'is-hl', focus && 'is-focus')}
            data-char-start={r.utf16Start}
            data-char-end={r.utf16End}
            x={r.rect.left}
            y={r.rect.top}
            width={Math.max(1, r.rect.right - r.rect.left)}
            height={Math.max(1, r.rect.bottom - r.rect.top)}
            rx={2}
          />
        );
      })}
    </g>
  );
});

export function BlockOverlay({ volumeId, page, showOutlines, sceneHint }: BlockOverlayProps) {
  const host = useHost();
  const request = useBreakdownStore((s) => s.request);
  const explanation = useBreakdownStore((s) => s.explanation);
  const focusCharIndex = useBreakdownStore((s) => s.focusCharIndex);
  const isOpen = useBreakdownStore((s) => s.isOpen);

  const source = request?.source;
  const activeBlockIndex =
    isOpen && source?.kind === 'manga' && source.volumeId === volumeId && source.pageIndex === page.index ? source.blockIndex : undefined;
  const activeBlock = activeBlockIndex === undefined ? undefined : page.blocks.find((b) => b.index === activeBlockIndex);
  const highlight = useMemo(
    () => (activeBlock && explanation?.sentence === activeBlock.text ? deriveSelection(explanation, focusCharIndex).highlightSpan : undefined),
    [activeBlock, explanation, focusCharIndex],
  );

  const onPick = (block: MangaBlock, charIndex: number): void => {
    void useBreakdownStore.getState().open(host, {
      sentence: block.text,
      source: { kind: 'manga', volumeId, pageIndex: page.index, blockIndex: block.index },
      focusCharIndex: charIndex,
      ...blockContext(page, block.index),
      sceneHint,
    });
  };

  if (page.blocks.length === 0) return null;
  return (
    <svg
      className="k-block-overlay"
      viewBox={`0 0 ${page.width} ${page.height}`}
      preserveAspectRatio="none"
      data-testid={`block-overlay-${page.index}`}
    >
      {page.blocks.map((b) => (
        <BlockShape
          key={b.index}
          block={b}
          active={b.index === activeBlockIndex}
          highlight={b.index === activeBlockIndex ? highlight : undefined}
          focusIndex={b.index === activeBlockIndex ? focusCharIndex : undefined}
          showOutlines={showOutlines}
          onPick={onPick}
        />
      ))}
    </svg>
  );
}
