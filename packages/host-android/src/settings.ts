/**
 * Settings store: defaults identical to the desktop host, deep-merge patches,
 * persisted in the IndexedDB `settings` store under key `app`, emits
 * `settings-changed` after every `update`.
 */
import type { AppSettings, HostEvent, SettingsPatch } from '@kotori/core';
import { KotoriError } from './adapters/core';
import type { KotoriDb } from './storage/idb';

const SETTINGS_KEY = 'app';

/** Defaults — keep identical to `@kotori/host-node` `settings/defaults.ts`. */
export function defaultSettings(downloadDir: string): AppSettings {
  return {
    schemaVersion: 1,
    ai: {
      provider: { provider: 'gemini-api', apiKey: '' },
      explainModel: 'gemini-2.5-flash',
      visionModel: 'gemini-2.5-flash',
      temperature: 0.2,
      targetLanguage: 'zh-CN',
      cacheEnabled: true,
      timeoutMs: 30000,
    },
    ui: { theme: 'system', seedColor: '#6750A4', locale: 'zh-CN', fontScale: 1 },
    anime: {
      mergeKaraokeCues: true,
      hideSigns: true,
      repeatCount: 3,
      pauseAfterJump: false,
      seekPaddingMs: 250,
      autoDownloadJimaku: false,
      jimakuApiKey: '',
      preferredSubtitleLanguages: ['ja'],
    },
    manga: {
      defaultReadingMode: 'spread-rtl',
      showBlockOutlines: false,
      fit: 'contain',
      background: 'black',
      preloadPages: 2,
    },
    downloads: {
      downloadDir,
      maxActiveDownloads: 3,
      maxPeersPerTorrent: 50,
      seedAfterComplete: false,
      nyaaBaseUrl: 'https://nyaa.si',
      mokuroCatalogUrl: 'https://mokuro.moe/manga/',
    },
    library: { animeRoots: [], mangaRoots: [] },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep merge where arrays replace, `undefined` patch values are ignored, and
 * discriminated unions (objects carrying a `provider` or `kind` string) are
 * replaced wholesale when the discriminant changes (Gemini ⇄ Vertex, auth kind).
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  for (const tag of ['provider', 'kind']) {
    const a = base[tag];
    const b = patch[tag];
    if (typeof a === 'string' && typeof b === 'string' && a !== b) return { ...patch };
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

/** Apply a settings patch (schemaVersion is never patchable). */
export function mergeSettings(base: AppSettings, patch: SettingsPatch | AppSettings): AppSettings {
  const merged = deepMerge(base, patch);
  if (!isPlainObject(merged)) throw new KotoriError('invalid-argument', 'invalid settings patch');
  // Safe: deepMerge only overlays keys present in `SettingsPatch` onto a full `AppSettings`.
  return { ...(merged as unknown as AppSettings), schemaVersion: 1 };
}

export interface SettingsStore {
  /** Synchronous snapshot (loaded at startup, updated on `update`). */
  current(): AppSettings;
  get(): Promise<AppSettings>;
  update(patch: SettingsPatch): Promise<AppSettings>;
}

/** Load persisted settings (merged over defaults so new fields get defaults). */
export async function createSettingsStore(db: KotoriDb, defaults: AppSettings, emit: (event: HostEvent) => void): Promise<SettingsStore> {
  const stored = await db.get('settings', SETTINGS_KEY);
  let current = stored === undefined ? defaults : mergeSettings(defaults, stored);
  return {
    current: () => current,
    get: () => Promise.resolve(current),
    async update(patch) {
      if (!isPlainObject(patch)) throw new KotoriError('invalid-argument', 'settings patch must be an object');
      const next = mergeSettings(current, patch);
      await db.put('settings', next, SETTINGS_KEY);
      current = next;
      emit({ type: 'settings-changed', settings: next });
      return next;
    },
  };
}
