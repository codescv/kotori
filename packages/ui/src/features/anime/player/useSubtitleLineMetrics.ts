/**
 * Responsive line-width measurement (`maxLineEm`) for `SubtitleOverlay` (§4.1).
 *
 * Measures the overlay's live content-box width and two hidden probe spans
 * (`.k-sub-line--probe`) via `ResizeObserver` + `getComputedStyle`.
 *
 * `fontPx` is NEVER synthesised: when `getComputedStyle(probe).fontSize` is not
 * a resolved finite `px` value (e.g. jsdom where `calc(var(...))` is unresolved),
 * all limits stay `Infinity` so JS wrapping is off and CSS `text-wrap: balance`
 * acts alone.
 */
import { useEffect, useState, type RefObject } from 'react';
import { useSettingsStore } from '../../../stores/settings';

export interface SubtitleLineMetrics {
  readonly primaryMaxEm: number;
  readonly secondaryMaxEm: number;
  readonly inlineSecondaryMaxEm: number;
}

export const UNBOUNDED_LINE_METRICS: SubtitleLineMetrics = Object.freeze({
  primaryMaxEm: Infinity,
  secondaryMaxEm: Infinity,
  inlineSecondaryMaxEm: Infinity,
});

const RESOLVED_PX_RE = /^\d+(?:\.\d+)?px$/;

function parsePx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function measureProbeMaxEm(W: number, probe: HTMLElement | null, fallbackMaxPct: number): number {
  if (!probe || !(W > 0) || typeof window === 'undefined') return Infinity;
  const cs = window.getComputedStyle(probe);
  const rawFont = cs.fontSize.trim();
  if (!RESOLVED_PX_RE.test(rawFont)) return Infinity;
  const fontPx = Number.parseFloat(rawFont);
  if (!Number.isFinite(fontPx) || fontPx < 8) return Infinity;

  const rawMaxW = cs.maxWidth.trim();
  let maxPct = fallbackMaxPct;
  if (rawMaxW.endsWith('%')) {
    const pct = Number.parseFloat(rawMaxW);
    if (Number.isFinite(pct) && pct > 0) maxPct = pct / 100;
  }

  const textPx = W * maxPct - parsePx(cs.paddingLeft) - parsePx(cs.paddingRight);
  const maxEm = textPx / fontPx - 0.15;
  if (!Number.isFinite(maxEm) || maxEm < 4) return Infinity;
  return maxEm;
}

function sameEm(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < 0.05;
}

export function useSubtitleLineMetrics(
  overlayRef: RefObject<HTMLElement | null>,
  primaryProbeRef: RefObject<HTMLElement | null>,
  secondaryProbeRef: RefObject<HTMLElement | null>,
  blind = false,
): SubtitleLineMetrics {
  const fontScale = useSettingsStore((s) => s.settings.ui.fontScale);
  const [metrics, setMetrics] = useState<SubtitleLineMetrics>(UNBOUNDED_LINE_METRICS);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (blind || !overlay || typeof window === 'undefined') {
      setMetrics((prev) =>
        sameEm(prev.primaryMaxEm, Infinity) && sameEm(prev.secondaryMaxEm, Infinity)
          ? prev
          : UNBOUNDED_LINE_METRICS,
      );
      return;
    }

    const update = (entryContentWidth?: number): void => {
      const el = overlayRef.current;
      const p1 = primaryProbeRef.current;
      const p2 = secondaryProbeRef.current;
      if (!el || !p1) {
        setMetrics((prev) =>
          sameEm(prev.primaryMaxEm, Infinity) && sameEm(prev.secondaryMaxEm, Infinity)
            ? prev
            : UNBOUNDED_LINE_METRICS,
        );
        return;
      }

      let W: number;
      if (el.clientWidth > 0) {
        const ocs = window.getComputedStyle(el);
        W = el.clientWidth - parsePx(ocs.paddingLeft) - parsePx(ocs.paddingRight);
      } else if (entryContentWidth !== undefined && entryContentWidth > 0) {
        W = entryContentWidth;
      } else {
        W = window.innerWidth * 0.94;
      }

      const primaryMaxEm = measureProbeMaxEm(W, p1, 0.96);
      const secondaryMaxEm = measureProbeMaxEm(W, p2, 0.92);
      const inlineSecondaryMaxEm = Number.isFinite(primaryMaxEm) ? primaryMaxEm / 0.72 : Infinity;

      setMetrics((prev) =>
        sameEm(prev.primaryMaxEm, primaryMaxEm) && sameEm(prev.secondaryMaxEm, secondaryMaxEm)
          ? prev
          : { primaryMaxEm, secondaryMaxEm, inlineSecondaryMaxEm },
      );
    };

    update();
    const rafId =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(() => update())
        : undefined;

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        update(entry?.contentRect.width);
      });
      ro.observe(overlay);
      return () => {
        if (rafId !== undefined) window.cancelAnimationFrame(rafId);
        ro.disconnect();
      };
    }

    const onResize = (): void => update();
    window.addEventListener('resize', onResize);
    return () => {
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, [overlayRef, primaryProbeRef, secondaryProbeRef, blind, fontScale]);

  return metrics;
}
