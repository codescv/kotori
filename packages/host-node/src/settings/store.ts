/**
 * `AppSettings` persistence (single JSON row in `settings`), defaults, deep
 * patch merge, schema migration and secret redaction for logs.
 */
import { join } from 'node:path';
import { KotoriError } from '@kotori/core';
import type { AppSettings, SettingsPatch } from '@kotori/core';
import type { Database } from '../db/sqlite';

export function defaultSettings(dataDir: string): AppSettings {
  return {
    schemaVersion: 1,
    ai: {
      provider: { provider: 'gemini-api', apiKey: '' },
      explainModel: 'gemini-3.8-flash',
      visionModel: 'gemini-3.8-flash',
      temperature: 0.2,
      targetLanguage: 'zh-CN',
      cacheEnabled: true,
      timeoutMs: 30_000,
    },
    ui: { theme: 'system', seedColor: '#8ab49a', locale: 'zh-CN', fontScale: 1 },
    anime: {
      mergeKaraokeCues: true,
      hideSigns: true,
      repeatCount: 3,
      pauseAfterJump: false,
      seekPaddingMs: 250,
      autoDownloadJimaku: true,
      jimakuApiKey: '',
      preferredSubtitleLanguages: ['ja'],
    },
    manga: { defaultReadingMode: 'spread-rtl', showBlockOutlines: false, fit: 'contain', background: 'black', preloadPages: 2 },
    downloads: {
      downloadDir: join(dataDir, 'downloads'),
      maxActiveDownloads: 3,
      maxPeersPerTorrent: 50,
      seedAfterComplete: false,
      nyaaBaseUrl: 'https://nyaa.si',
      mokuroCatalogUrl: 'https://mokuro.moe/manga/',
    },
    library: { animeRoots: [], mangaRoots: [] },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep merge where arrays and discriminated objects with a changed
 * `provider`/`kind` tag are replaced wholesale (so switching AI provider
 * does not leak fields of the previous variant). A `null` value deletes an
 * optional key (e.g. clearing `ai.thinkingBudget` or a provider `baseUrl`);
 * required fields deleted this way are caught by `validateSettings`.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : structuredClone(patch)) as T;
  for (const tag of ['provider', 'kind'] as const) {
    if (typeof patch[tag] === 'string' && patch[tag] !== base[tag]) return stripNulls(structuredClone(patch)) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : structuredClone(value);
  }
  return out as T;
}

function stripNulls(value: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(value)) {
    if (v === null) delete value[k];
    else if (isPlainObject(v)) stripNulls(v);
  }
  return value;
}

const THEMES = ['system', 'light', 'dark'];
const LOCALES = ['zh-CN', 'en', 'ja'];
const APP_ICONS = ['s4-01', 's4-02', 's4-03', 's4-04', 's3-01', 's3-02', 's3-03', 's3-04'];
const TARGET_LANGUAGES = ['zh-CN', 'zh-TW', 'en'];
const READING_MODES = ['single-rtl', 'single-ltr', 'spread-rtl', 'spread-ltr', 'webtoon'];
const FITS = ['contain', 'width', 'height'];
const BACKGROUNDS = ['black', 'surface', 'white'];
const VERTEX_AUTH_KINDS = ['access-token', 'adc', 'service-account-json', 'express-api-key'];

/** Validate types, enums and ranges; throws `invalid-argument` naming the offending field. */
export function validateSettings(s: AppSettings): void {
  const fail = (field: string, msg: string): never => {
    throw new KotoriError('invalid-argument', `${field}: ${msg}`, { details: { field } });
  };
  const number = (field: string, v: unknown, min: number, max = Number.POSITIVE_INFINITY): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(field, `must be a number within ${min}..${max}`);
  };
  const optNumber = (field: string, v: unknown, min: number): void => {
    if (v !== undefined) number(field, v, min);
  };
  const oneOf = (field: string, v: unknown, values: readonly string[]): void => {
    if (typeof v !== 'string' || !values.includes(v)) fail(field, `must be one of ${values.join(', ')}`);
  };
  const str = (field: string, v: unknown): void => {
    if (typeof v !== 'string') fail(field, 'must be a string');
  };
  const bool = (field: string, v: unknown): void => {
    if (typeof v !== 'boolean') fail(field, 'must be a boolean');
  };
  const strings = (field: string, v: unknown): void => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(field, 'must be an array of strings');
  };
  for (const section of ['ai', 'ui', 'anime', 'manga', 'downloads', 'library'] as const) {
    if (!isPlainObject(s[section])) fail(section, 'must be an object');
  }
  // ai
  const provider = s.ai.provider as unknown;
  if (!isPlainObject(provider)) fail('ai.provider', 'must be an object');
  const p = s.ai.provider;
  if (p.provider === 'gemini-api') {
    str('ai.provider.apiKey', p.apiKey);
    if (p.baseUrl !== undefined) str('ai.provider.baseUrl', p.baseUrl);
    if (p.apiVersion !== undefined) oneOf('ai.provider.apiVersion', p.apiVersion, ['v1', 'v1beta']);
  } else if (p.provider === 'vertex-ai') {
    if (typeof p.location !== 'string' || !p.location) fail('ai.provider.location', 'required');
    if (p.project !== undefined) str('ai.provider.project', p.project);
    if (!isPlainObject(p.auth as unknown)) fail('ai.provider.auth', 'must be an object');
    oneOf('ai.provider.auth.kind', p.auth.kind, VERTEX_AUTH_KINDS);
  } else {
    fail('ai.provider', 'unknown provider');
  }
  str('ai.explainModel', s.ai.explainModel);
  str('ai.visionModel', s.ai.visionModel);
  number('ai.temperature', s.ai.temperature, 0, 2);
  optNumber('ai.thinkingBudget', s.ai.thinkingBudget, 0);
  oneOf('ai.targetLanguage', s.ai.targetLanguage, TARGET_LANGUAGES);
  bool('ai.cacheEnabled', s.ai.cacheEnabled);
  number('ai.timeoutMs', s.ai.timeoutMs, 1000);
  if (s.ai.persona !== undefined) {
    if (!isPlainObject(s.ai.persona)) fail('ai.persona', 'must be an object');
    if (s.ai.persona.name !== undefined) str('ai.persona.name', s.ai.persona.name);
    if (s.ai.persona.avatarUrl !== undefined) str('ai.persona.avatarUrl', s.ai.persona.avatarUrl);
    if (s.ai.persona.soul !== undefined) str('ai.persona.soul', s.ai.persona.soul);
  }
  // ui
  oneOf('ui.theme', s.ui.theme, THEMES);
  if (typeof s.ui.seedColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.ui.seedColor)) fail('ui.seedColor', 'must be #RRGGBB');
  oneOf('ui.locale', s.ui.locale, LOCALES);
  number('ui.fontScale', s.ui.fontScale, 0.5, 3);
  if (s.ui.appIcon !== undefined) oneOf('ui.appIcon', s.ui.appIcon, APP_ICONS);
  // anime
  bool('anime.mergeKaraokeCues', s.anime.mergeKaraokeCues);
  bool('anime.hideSigns', s.anime.hideSigns);
  number('anime.repeatCount', s.anime.repeatCount, 0);
  bool('anime.pauseAfterJump', s.anime.pauseAfterJump);
  number('anime.seekPaddingMs', s.anime.seekPaddingMs, 0);
  bool('anime.autoDownloadJimaku', s.anime.autoDownloadJimaku);
  str('anime.jimakuApiKey', s.anime.jimakuApiKey);
  strings('anime.preferredSubtitleLanguages', s.anime.preferredSubtitleLanguages);
  // manga
  oneOf('manga.defaultReadingMode', s.manga.defaultReadingMode, READING_MODES);
  bool('manga.showBlockOutlines', s.manga.showBlockOutlines);
  oneOf('manga.fit', s.manga.fit, FITS);
  oneOf('manga.background', s.manga.background, BACKGROUNDS);
  number('manga.preloadPages', s.manga.preloadPages, 0, 20);
  // downloads
  str('downloads.downloadDir', s.downloads.downloadDir);
  number('downloads.maxActiveDownloads', s.downloads.maxActiveDownloads, 1, 20);
  number('downloads.maxPeersPerTorrent', s.downloads.maxPeersPerTorrent, 1, 1000);
  optNumber('downloads.uploadLimitBps', s.downloads.uploadLimitBps, 0);
  optNumber('downloads.downloadLimitBps', s.downloads.downloadLimitBps, 0);
  bool('downloads.seedAfterComplete', s.downloads.seedAfterComplete);
  str('downloads.nyaaBaseUrl', s.downloads.nyaaBaseUrl);
  str('downloads.mokuroCatalogUrl', s.downloads.mokuroCatalogUrl);
  // library
  strings('library.animeRoots', s.library.animeRoots);
  strings('library.mangaRoots', s.library.mangaRoots);
}

const SECRET_KEYS = new Set(['apiKey', 'accessToken', 'json', 'jimakuApiKey']);

/** Deep copy with secrets replaced by `***` (for logs / diagnostics). */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => redactSecrets(v)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k) && typeof v === 'string' && v.length > 0 ? '***' : redactSecrets(v);
  }
  return out as T;
}

const ROW_KEY = 'app';

export class SettingsStore {
  private cache: AppSettings | undefined;

  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
  ) {}

  get(): AppSettings {
    if (this.cache) return this.cache;
    const defaults = defaultSettings(this.dataDir);
    const row = this.db.prepare('SELECT json FROM settings WHERE key = ?').get(ROW_KEY) as { json: string } | undefined;
    let loaded = defaults;
    if (row) {
      try {
        // Merge onto defaults so newly added fields get default values (forward migration).
        loaded = deepMerge(defaults, this.migrate(JSON.parse(row.json) as Record<string, unknown>));
      } catch (error) {
        console.warn('[kotori:settings] corrupt settings row, using defaults', error);
      }
    }
    this.cache = loaded;
    return loaded;
  }

  update(patch: SettingsPatch): AppSettings {
    if (!isPlainObject(patch)) throw new KotoriError('invalid-argument', 'settings patch must be an object');
    const { schemaVersion: _ignored, ...rest } = patch as Record<string, unknown>;
    for (const [section, value] of Object.entries(rest)) {
      if (value !== undefined && !isPlainObject(value)) {
        throw new KotoriError('invalid-argument', `${section}: must be an object`, { details: { field: section } });
      }
    }
    const next = deepMerge(this.get(), rest);
    validateSettings(next);
    this.db
      .prepare('INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json')
      .run(ROW_KEY, JSON.stringify(next));
    this.cache = next;
    return next;
  }

  /** Upgrade stored JSON from older schema versions (v1 is the first). */
  private migrate(raw: Record<string, unknown>): Record<string, unknown> {
    return { ...raw, schemaVersion: 1 };
  }
}
