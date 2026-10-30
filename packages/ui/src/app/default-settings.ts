/**
 * Default `AppSettings` used by the mock host and as the UI's pre-load
 * fallback (so the theme / locale render before `settings.get()` resolves).
 */
import type { AppSettings, DeepPartial, SettingsPatch } from '@kotori/core';
import { DEFAULT_SEED_COLOR } from '../theme/m3-theme';

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  ai: {
    provider: { provider: 'gemini-api', apiKey: '' },
    explainModel: 'gemini-3.5-flash-lite',
    visionModel: 'gemini-3.5-flash-lite',
    temperature: 0.2,
    thinkingBudget: 0,
    targetLanguage: 'zh-CN',
    cacheEnabled: true,
    timeoutMs: 30_000,
  },
  ui: { theme: 'system', seedColor: DEFAULT_SEED_COLOR, locale: 'zh-CN', fontScale: 1 },
  anime: {
    mergeKaraokeCues: true,
    hideSigns: true,
    repeatCount: 3,
    pauseAfterJump: false,
    seekPaddingMs: 200,
    autoDownloadJimaku: true,
    jimakuApiKey: '',
    preferredSubtitleLanguages: ['ja'],
    secondarySubtitle: 'auto',
    preferredSecondarySubtitleLanguages: ['zh-CN', 'zh', 'zh-TW', 'en'],
    autoPreExplain: false,
  },
  manga: {
    defaultReadingMode: 'spread-rtl',
    showBlockOutlines: true,
    fit: 'contain',
    background: 'surface',
    preloadPages: 2,
    autoPreExplain: false,
  },
  downloads: {
    downloadDir: '~/.kotori/anime',
    maxActiveDownloads: 3,
    maxPeersPerTorrent: 50,
    seedAfterComplete: false,
    nyaaBaseUrl: 'https://nyaa.si',
    mokuroCatalogUrl: 'https://mokuro.moe/manga/',
  },
  library: { animeRoots: [], mangaRoots: [] },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deep-merge a settings patch. Arrays and discriminated objects with a
 * `provider`/`kind` tag that changes are replaced wholesale (switching the AI
 * provider must not leak fields of the previous variant).
 */
export function mergeDeep<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const tagChanged =
    ('provider' in patch && patch['provider'] !== base['provider'] && typeof patch['provider'] === 'string') ||
    ('kind' in patch && patch['kind'] !== base['kind'] && typeof patch['kind'] === 'string');
  if (tagChanged) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDeep(out[k], v) : v;
  }
  return out as T;
}

export function applySettingsPatch(settings: AppSettings, patch: SettingsPatch): AppSettings {
  return mergeDeep<AppSettings>(settings, patch as DeepPartial<AppSettings>);
}
