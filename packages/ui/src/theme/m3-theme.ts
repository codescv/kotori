/**
 * Material 3 dynamic colour → CSS custom properties.
 *
 * `buildM3Tokens(seed, dark)` derives a complete M3 colour scheme (incl. the
 * surface-container roles) from one seed using the official
 * `@material/material-color-utilities` tonal-spot algorithm, and returns it as
 * `--md-sys-color-*` variables consumed by `styles.css` and every component.
 */
import {
  argbFromHex,
  hexFromArgb,
  Hct,
  MaterialDynamicColors,
  SchemeTonalSpot,
  type DynamicColor,
} from '@material/material-color-utilities';

/** Kotori's default seed: a calm sage green (ことり). */
export const DEFAULT_SEED_COLOR = '#8ab49a';

/** Colour roles exported as CSS variables (kebab-cased). */
const ROLES = {
  primary: MaterialDynamicColors.primary,
  'on-primary': MaterialDynamicColors.onPrimary,
  'primary-container': MaterialDynamicColors.primaryContainer,
  'on-primary-container': MaterialDynamicColors.onPrimaryContainer,
  'inverse-primary': MaterialDynamicColors.inversePrimary,
  secondary: MaterialDynamicColors.secondary,
  'on-secondary': MaterialDynamicColors.onSecondary,
  'secondary-container': MaterialDynamicColors.secondaryContainer,
  'on-secondary-container': MaterialDynamicColors.onSecondaryContainer,
  tertiary: MaterialDynamicColors.tertiary,
  'on-tertiary': MaterialDynamicColors.onTertiary,
  'tertiary-container': MaterialDynamicColors.tertiaryContainer,
  'on-tertiary-container': MaterialDynamicColors.onTertiaryContainer,
  error: MaterialDynamicColors.error,
  'on-error': MaterialDynamicColors.onError,
  'error-container': MaterialDynamicColors.errorContainer,
  'on-error-container': MaterialDynamicColors.onErrorContainer,
  background: MaterialDynamicColors.background,
  'on-background': MaterialDynamicColors.onBackground,
  surface: MaterialDynamicColors.surface,
  'surface-dim': MaterialDynamicColors.surfaceDim,
  'surface-bright': MaterialDynamicColors.surfaceBright,
  'surface-container-lowest': MaterialDynamicColors.surfaceContainerLowest,
  'surface-container-low': MaterialDynamicColors.surfaceContainerLow,
  'surface-container': MaterialDynamicColors.surfaceContainer,
  'surface-container-high': MaterialDynamicColors.surfaceContainerHigh,
  'surface-container-highest': MaterialDynamicColors.surfaceContainerHighest,
  'on-surface': MaterialDynamicColors.onSurface,
  'surface-variant': MaterialDynamicColors.surfaceVariant,
  'on-surface-variant': MaterialDynamicColors.onSurfaceVariant,
  'inverse-surface': MaterialDynamicColors.inverseSurface,
  'inverse-on-surface': MaterialDynamicColors.inverseOnSurface,
  outline: MaterialDynamicColors.outline,
  'outline-variant': MaterialDynamicColors.outlineVariant,
  shadow: MaterialDynamicColors.shadow,
  scrim: MaterialDynamicColors.scrim,
  'surface-tint': MaterialDynamicColors.surfaceTint,
} as const satisfies Record<string, DynamicColor>;

export type M3Role = keyof typeof ROLES;
export type M3Tokens = Readonly<Record<`--md-sys-color-${M3Role}`, string>>;

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Accepts `#abc` / `#aabbcc` / `aabbcc`; invalid input falls back to the default seed. */
export function normaliseSeed(seed: string | undefined): string {
  const m = HEX_RE.exec((seed ?? '').trim());
  if (!m?.[1]) return DEFAULT_SEED_COLOR;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return `#${hex.toLowerCase()}`;
}

const cache = new Map<string, M3Tokens>();

/** Full M3 tonal-spot scheme for `seed` as CSS custom properties. Memoised. */
export function buildM3Tokens(seed: string, dark: boolean, contrast = 0): M3Tokens {
  const key = `${normaliseSeed(seed)}|${dark ? 'd' : 'l'}|${contrast}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(normaliseSeed(seed))), dark, contrast);
  const tokens: Record<string, string> = {};
  for (const [name, color] of Object.entries(ROLES)) {
    tokens[`--md-sys-color-${name}`] = hexFromArgb(color.getArgb(scheme));
  }
  const result = tokens as M3Tokens;
  cache.set(key, result);
  return result;
}

/** Writes tokens onto an element (usually `document.documentElement`). */
export function applyM3Tokens(el: HTMLElement, tokens: M3Tokens, dark: boolean): void {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(k, v);
  el.dataset['theme'] = dark ? 'dark' : 'light';
  el.style.colorScheme = dark ? 'dark' : 'light';
}

/** Hex → `r, g, b` triplet (for `rgb(var(--x-rgb) / α)` state layers). */
export function hexToRgbTriplet(hex: string): string {
  const n = argbFromHex(normaliseSeed(hex));
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
