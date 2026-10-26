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

/** M3 window size classes: compact < 600 ≤ medium < 840 ≤ expanded. */
export const EXPANDED_QUERY = '(min-width: 840px)';

export function useIsExpanded(): boolean {
  return useMediaQuery(EXPANDED_QUERY);
}
