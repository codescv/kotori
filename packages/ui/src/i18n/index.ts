/**
 * Tiny i18n: plain dictionaries + `t(key, vars)` with `{name}` interpolation.
 * The active locale comes from `UiSettings.locale` (settings store).
 */
import { useMemo } from 'react';
import type { UiSettings } from '@kotori/core';
import { useSettingsStore } from '../stores/settings';
import { en } from './en';
import { ja } from './ja';
import { zhCN, type MessageKey, type Messages } from './zh-CN';

export type { MessageKey, Messages } from './zh-CN';
export type Locale = UiSettings['locale'];

export const DICTIONARIES: Readonly<Record<Locale, Messages>> = { 'zh-CN': zhCN, en, ja };

export type TranslateVars = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, vars?: TranslateVars) => string;

/** Translate `key` in `locale`, interpolating `{name}` placeholders. */
export function translate(locale: Locale, key: MessageKey, vars?: TranslateVars): string {
  const template = DICTIONARIES[locale][key] ?? zhCN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function createTranslator(locale: Locale): Translate {
  return (key, vars) => translate(locale, key, vars);
}

/** React hook: translator bound to the current UI locale. */
export function useT(): Translate {
  const locale = useSettingsStore((s) => s.settings.ui.locale);
  return useMemo(() => createTranslator(locale), [locale]);
}
