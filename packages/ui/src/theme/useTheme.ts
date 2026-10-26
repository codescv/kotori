/**
 * Applies the M3 theme derived from `UiSettings` (seed colour + light/dark/
 * system) to `document.documentElement` and keeps it in sync with the OS
 * colour-scheme preference. Also publishes `--kotori-font-scale`.
 */
import { useLayoutEffect, useMemo } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useSettingsStore } from '../stores/settings';
import { applyM3Tokens, buildM3Tokens, normaliseSeed, type M3Tokens } from './m3-theme';

export interface ThemeState {
  readonly dark: boolean;
  readonly seed: string;
  readonly tokens: M3Tokens;
}

/** Resolve (without side effects) the effective theme for the current settings. */
export function useResolvedTheme(): ThemeState {
  const ui = useSettingsStore((s) => s.settings.ui);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const dark = ui.theme === 'dark' || (ui.theme === 'system' && systemDark);
  const seed = normaliseSeed(ui.seedColor);
  const tokens = useMemo(() => buildM3Tokens(seed, dark), [seed, dark]);
  return { dark, seed, tokens };
}

/** Resolve and apply the theme to `target` (default: the document root). */
export function useTheme(target?: HTMLElement | null): ThemeState {
  const theme = useResolvedTheme();
  const fontScale = useSettingsStore((s) => s.settings.ui.fontScale);
  useLayoutEffect(() => {
    const el = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
    if (!el) return;
    applyM3Tokens(el, theme.tokens, theme.dark);
    el.style.setProperty('--kotori-font-scale', String(fontScale));
    if (el.dataset['themeReady'] === undefined && typeof requestAnimationFrame === 'function') {
      // Enable colour transitions only after the first themed frame has painted.
      requestAnimationFrame(() => requestAnimationFrame(() => (el.dataset['themeReady'] = '')));
    }
  }, [target, theme.tokens, theme.dark, fontScale]);
  return theme;
}
