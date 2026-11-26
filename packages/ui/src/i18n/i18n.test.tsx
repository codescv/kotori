import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../app/default-settings';
import { AppearanceSection } from '../features/settings/AppearanceSection';
import { HostProvider } from '../host/HostContext';
import { createMockPlatformHost } from '../host/mock-host';
import { useSettingsStore } from '../stores/settings';
import { useTheme } from '../theme/useTheme';
import { DICTIONARIES, resolveLocale, resolveSystemLocale, translate } from './index';
import { en } from './en';
import { ja } from './ja';
import { zhCN } from './zh-CN';

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

function extractPlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names].sort();
}

describe('i18n locale resolution & defaults', () => {
  it('defaults UiSettings.locale to system', () => {
    expect(DEFAULT_SETTINGS.ui.locale).toBe('system');
  });

  it('resolves system language tags to zh-CN, ja, or en fallback', () => {
    expect(resolveSystemLocale('zh')).toBe('zh-CN');
    expect(resolveSystemLocale('zh-CN')).toBe('zh-CN');
    expect(resolveSystemLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveSystemLocale('zh-TW')).toBe('zh-CN');
    expect(resolveSystemLocale('zh_HK')).toBe('zh-CN');
    expect(resolveSystemLocale('ja')).toBe('ja');
    expect(resolveSystemLocale('ja-JP')).toBe('ja');
    expect(resolveSystemLocale('ja_JP')).toBe('ja');
    expect(resolveSystemLocale('en')).toBe('en');
    expect(resolveSystemLocale('en-US')).toBe('en');
    expect(resolveSystemLocale('fr-FR')).toBe('en');
    expect(resolveSystemLocale('de-DE')).toBe('en');
    expect(resolveSystemLocale('ko-KR')).toBe('en');
    expect(resolveSystemLocale('')).toBe('en');
    expect(resolveSystemLocale(null)).toBe('en');
  });

  it('resolves explicit locale overrides and system fallback consistently', () => {
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('ja', 'en-US')).toBe('ja');
    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'ja-JP')).toBe('ja');
    expect(resolveLocale('system', 'es-ES')).toBe('en');
    expect(resolveLocale(undefined, 'ja-JP')).toBe('ja');
  });

  it('translates with interpolation in all locales', () => {
    expect(translate('zh-CN', 'anime.library.episodes', { count: 12 })).toBe('12 集');
    expect(translate('en', 'anime.library.episodes', { count: 12 })).toBe('12 episodes');
    expect(translate('ja', 'anime.library.episodes', { count: 12 })).toBe('全12話');
  });
});

describe('i18n dictionary parity & cleanliness', () => {
  const zhKeys = Object.keys(zhCN).sort();
  const enKeys = Object.keys(en).sort();
  const jaKeys = Object.keys(ja).sort();

  it('maintains 100% key parity across zh-CN, en, and ja', () => {
    expect(enKeys).toEqual(zhKeys);
    expect(jaKeys).toEqual(zhKeys);
    expect(Object.keys(DICTIONARIES).sort()).toEqual(['en', 'ja', 'zh-CN']);
  });

  it('has non-empty strings and matching {placeholders} across all locales', () => {
    for (const key of zhKeys) {
      const k = key as keyof typeof zhCN;
      expect(zhCN[k].trim().length, `zh-CN empty: ${k}`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en empty: ${k}`).toBeGreaterThan(0);
      expect(ja[k].trim().length, `ja empty: ${k}`).toBeGreaterThan(0);
      const zhVars = extractPlaceholders(zhCN[k]);
      expect(extractPlaceholders(en[k]), `en placeholder mismatch for ${k}`).toEqual(zhVars);
      expect(extractPlaceholders(ja[k]), `ja placeholder mismatch for ${k}`).toEqual(zhVars);
    }
  });

  it('contains no bilingual mixed chrome strings (生肉 Raw / 全集 Batch / 仅合集 Batch)', () => {
    for (const [locale, dict] of Object.entries(DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value, `${locale}:${key}`).not.toMatch(/生肉\s*Raw|全集\s*Batch|仅合集\s*Batch/i);
      }
    }
  });

  it('has zero leftover hardcoded CJK UI chrome strings in non-domain UI source files', () => {
    const srcRoot = resolve(import.meta.dirname, '..');
    const domainAllowlist = new Set([
      'components/AssistantAvatar.tsx',
      'components/breakdown/PitchAccentBadge.tsx',
      'components/breakdown/RubyText.tsx',
      'components/breakdown/VocabList.tsx',
      'components/breakdown/romaji.ts',
      'components/breakdown/useBreakdownSelection.ts',
      'features/ai-cache/collect.ts',
      'features/ai-cache/tracks.ts',
      'features/anime/player/SubtitleTrackMenu.tsx',
      'features/downloads/anilist.ts',
      'features/downloads/format.ts',
      'features/settings/AiProviderForm.tsx',
      'features/settings/AppearanceSection.tsx',
      'lib/manga.ts',
    ]);
    const offenders: string[] = [];
    for (const file of walkTsFiles(srcRoot)) {
      const rel = relative(srcRoot, file).replace(/\\/g, '/');
      if (rel.startsWith('i18n/') || rel.startsWith('host/mock') || domainAllowlist.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line)) continue;
        const stripped = line.replace(/\/\/.*$/, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
        if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(stripped)) {
          offenders.push(`${rel}:${i + 1}: ${stripped.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('AppearanceSection language switcher & document.documentElement.lang sync', () => {
  function AppearanceHarness() {
    useTheme();
    return <AppearanceSection />;
  }

  const origLanguage = navigator.language;
  const origLanguages = navigator.languages;

  function setNavigatorLanguage(lang: string) {
    Object.defineProperty(navigator, 'language', { configurable: true, value: lang });
    Object.defineProperty(navigator, 'languages', { configurable: true, value: [lang] });
  }

  beforeEach(() => {
    useSettingsStore.getState().reset();
    setNavigatorLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'language', { configurable: true, value: origLanguage });
    Object.defineProperty(navigator, 'languages', { configurable: true, value: origLanguages });
  });

  it('resolves system locale from navigator.language on mount (en fallback, ja, zh-CN)', async () => {
    for (const [navLang, expectedLang, expectedHeading] of [
      ['fr-FR', 'en', 'Interface language'],
      ['ja-JP', 'ja', '表示言語'],
      ['zh-Hans-CN', 'zh-CN', '界面语言'],
    ] as const) {
      cleanup();
      useSettingsStore.getState().reset();
      setNavigatorLanguage(navLang);
      const host = createMockPlatformHost({ latencyMs: 0 });
      await useSettingsStore.getState().load(host);
      render(
        <HostProvider host={host}>
          <AppearanceHarness />
        </HostProvider>,
      );
      await waitFor(() => {
        expect(document.documentElement.lang).toBe(expectedLang);
        expect(screen.getByText(expectedHeading)).toBeInTheDocument();
      });
    }
  });

  it('exposes System Default, 中文, English, and 日本語 and updates UI + html[lang] live', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    await useSettingsStore.getState().load(host);
    render(
      <HostProvider host={host}>
        <AppearanceHarness />
      </HostProvider>,
    );

    const localeGroup = screen.getByRole('radiogroup', { name: /Interface language|界面语言|表示言語/ });
    const radios = within(localeGroup).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(localeGroup).getByRole('radio', { name: '中文' }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(screen.getByText('界面语言')).toBeInTheDocument();
      expect(within(localeGroup).getByRole('radio', { name: '跟随系统' })).toBeInTheDocument();
    });

    fireEvent.click(within(localeGroup).getByRole('radio', { name: '日本語' }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ja');
      expect(screen.getByText('表示言語')).toBeInTheDocument();
      expect(within(localeGroup).getByRole('radio', { name: 'システムに従う' })).toBeInTheDocument();
    });

    fireEvent.click(within(localeGroup).getByRole('radio', { name: 'English' }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('en');
      expect(screen.getByText('Interface language')).toBeInTheDocument();
      expect(within(localeGroup).getByRole('radio', { name: 'System Default' })).toBeInTheDocument();
    });
  });
});
