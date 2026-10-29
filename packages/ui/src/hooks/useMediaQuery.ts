/** Subscribe to a CSS media query (SSR/jsdom-safe: `false` when matchMedia is missing). */
import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/**
 * M3 window size classes: compact < 600 ≤ medium < 840 ≤ expanded. A phone
 * held in landscape (e.g. 915×412, 844×390) is wide but short, so the expanded
 * layout (NavRail + docked 440 px SideSheet) also requires ≥ 500 px height.
 */
export const EXPANDED_QUERY = '(min-width: 840px) and (min-height: 500px)';

export function useIsExpanded(): boolean {
  return useMediaQuery(EXPANDED_QUERY);
}

/** Phones held in landscape (e.g. 915×412, 844×390, 800×360, DPI-scaled ≤ 560px tall). */
export const MOBILE_LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 560px)';

export function useIsMobileLandscape(): boolean {
  return useMediaQuery(MOBILE_LANDSCAPE_QUERY);
}

/** Phones held in portrait (< 840px wide in portrait orientation). */
export const MOBILE_PORTRAIT_QUERY = '(max-width: 839px) and (orientation: portrait)';

export function useIsMobilePortrait(): boolean {
  return useMediaQuery(MOBILE_PORTRAIT_QUERY);
}
