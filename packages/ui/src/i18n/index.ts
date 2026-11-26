/**
 * Tiny i18n: plain dictionaries + `t(key, vars)` with `{name}` interpolation.
 * The active locale setting comes from `UiSettings.locale` (`'system' | 'zh-CN' | 'en' | 'ja'`);
 * `'system'` resolves from `navigator.language` (`zh*` → `'zh-CN'`, `ja*` → `'ja'`, else `'en'`).
 */
import { useEffect, useMemo, useState } from 'react';
import type { UiLocale, UiLocaleSetting } from '@kotori/core';
import { useSettingsStore } from '../stores/settings';
import { en } from './en';
import { ja } from './ja';
import { zhCN, type MessageKey, type Messages } from './zh-CN';

export type { MessageKey, Messages } from './zh-CN';
export type Locale = UiLocale;
export type LocaleSetting = UiLocaleSetting;

export const DICTIONARIES: Readonly<Record<Locale, Messages>> = { 'zh-CN': zhCN, en, ja };

export type TranslateVars = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, vars?: TranslateVars) => string;

/** Resolve a BCP-47 tag (or `navigator.language`) to a supported UI locale. */
export function resolveSystemLocale(language?: string | null): Locale {
  const raw =
    language !== undefined
      ? (language ?? '')
      : typeof navigator !== 'undefined'
        ? (navigator.language || navigator.languages?.[0] || '')
        : '';
  const lower = raw.trim().toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_')) return 'zh-CN';
  if (lower === 'ja' || lower.startsWith('ja-') || lower.startsWith('ja_')) return 'ja';
  return 'en';
}

/** Resolve a `UiSettings['locale']` setting (`'system'` or explicit) to a concrete dictionary locale. */
export function resolveLocale(setting: LocaleSetting | string | undefined, systemLanguage?: string | null): Locale {
  if (setting === 'zh-CN' || setting === 'en' || setting === 'ja') return setting;
  return resolveSystemLocale(systemLanguage);
}

/** Translate `key` in `locale` (accepts `'system'` or a concrete locale), interpolating `{name}` placeholders. */
export function translate(locale: LocaleSetting, key: MessageKey, vars?: TranslateVars): string {
  const resolved = resolveLocale(locale);
  const template = DICTIONARIES[resolved][key] ?? en[key] ?? zhCN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function createTranslator(locale: LocaleSetting): Translate {
  const resolved = resolveLocale(locale);
  return (key, vars) => translate(resolved, key, vars);
}

/** Non-React helper: current resolved locale from the settings store. */
export function getCurrentLocale(): Locale {
  return resolveLocale(useSettingsStore.getState().settings.ui.locale);
}

/** Non-React helper: translator bound to the current resolved locale. */
export function getCurrentTranslator(): Translate {
  return createTranslator(getCurrentLocale());
}

/** React hook: currently active resolved locale (`'zh-CN' | 'en' | 'ja'`). */
export function useLocale(): Locale {
  const setting = useSettingsStore((s) => s.settings.ui.locale);
  const [sysLocale, setSysLocale] = useState<Locale>(() => resolveSystemLocale());
  useEffect(() => {
    if (setting !== 'system' || typeof window === 'undefined') return;
    const sync = (): void => setSysLocale(resolveSystemLocale());
    sync();
    window.addEventListener('languagechange', sync);
    return () => window.removeEventListener('languagechange', sync);
  }, [setting]);
  return setting === 'system' ? sysLocale : resolveLocale(setting);
}

/** React hook: translator bound to the current resolved UI locale. */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo(() => createTranslator(locale), [locale]);
}
