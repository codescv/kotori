import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KotoriError } from '@kotori/core';
import type { SettingsPatch } from '@kotori/core';
import { openDatabase, type Database } from '../db/sqlite';
import { SettingsStore, deepMerge, defaultSettings, redactSecrets, validateSettings } from './store';

const DATA_DIR = join(tmpdir(), 'kotori-settings-data');

const tmpDirs: string[] = [];
const dbs: Database[] = [];

function memDb(): Database {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

function fileDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kotori-settings-test-'));
  tmpDirs.push(dir);
  return join(dir, 'kotori.db');
}

function openFile(path: string): Database {
  const db = openDatabase(path);
  dbs.push(db);
  return db;
}

function storedJson(db: Database): unknown {
  const row = db.prepare("SELECT json FROM settings WHERE key = 'app'").get() as { json: string } | undefined;
  return row === undefined ? undefined : JSON.parse(row.json);
}

/** Capture the KotoriError thrown by `fn` (fails the test if nothing / something else is thrown). */
function catchKotori(fn: () => unknown): KotoriError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KotoriError);
    return error as KotoriError;
  }
  throw new Error('expected a KotoriError to be thrown');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('defaultSettings', () => {
  it('derives the download dir from dataDir and passes validation', () => {
    const d = defaultSettings(DATA_DIR);
    expect(d.schemaVersion).toBe(1);
    expect(d.downloads.downloadDir).toBe(join(DATA_DIR, 'downloads'));
    expect(d.ai.provider).toEqual({ provider: 'gemini-api', apiKey: '' });
    expect(d.ai).toMatchObject({ temperature: 0.2, targetLanguage: 'zh-CN', cacheEnabled: true, timeoutMs: 30_000 });
    expect(d.library).toEqual({ animeRoots: [], mangaRoots: [] });
    expect(() => validateSettings(d)).not.toThrow();
  });

  it('returns a fresh object each call', () => {
    expect(defaultSettings(DATA_DIR)).not.toBe(defaultSettings(DATA_DIR));
    expect(defaultSettings(DATA_DIR)).toEqual(defaultSettings(DATA_DIR));
  });
});

describe('deepMerge', () => {
  it('merges nested objects without mutating the base', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, keep: 'k' };
    const snapshot = structuredClone(base);
    const out = deepMerge(base, { nested: { y: 3 } });
    expect(out).toEqual({ a: 1, nested: { x: 1, y: 3 }, keep: 'k' });
    expect(base).toEqual(snapshot);
    expect(out.nested).not.toBe(base.nested);
  });

  it('replaces arrays wholesale and skips undefined patch values', () => {
    const out = deepMerge({ list: [1, 2, 3], v: 1 }, { list: [9], v: undefined });
    expect(out).toEqual({ list: [9], v: 1 });
  });

  it('returns base for an undefined patch and the patch for non-object patches', () => {
    const base = { a: 1 };
    expect(deepMerge(base, undefined)).toBe(base);
    expect(deepMerge(base, 5)).toBe(5);
    expect(deepMerge(base, null)).toBeNull();
    expect(deepMerge(base, [1])).toEqual([1]);
    expect(deepMerge(3, { a: 1 })).toEqual({ a: 1 });
  });

  it('replaces the whole object when the provider/kind discriminant changes', () => {
    const gemini = { provider: 'gemini-api', apiKey: 'secret', baseUrl: 'https://proxy' };
    expect(deepMerge(gemini, { provider: 'vertex-ai', location: 'global' })).toEqual({ provider: 'vertex-ai', location: 'global' });
    const adc = { kind: 'adc' };
    expect(deepMerge(adc, { kind: 'express-api-key', apiKey: 'k' })).toEqual({ kind: 'express-api-key', apiKey: 'k' });
  });

  it('merges normally when the discriminant is unchanged or absent', () => {
    const gemini = { provider: 'gemini-api', apiKey: 'old', baseUrl: 'https://proxy' };
    expect(deepMerge(gemini, { provider: 'gemini-api', apiKey: 'new' })).toEqual({ provider: 'gemini-api', apiKey: 'new', baseUrl: 'https://proxy' });
    expect(deepMerge(gemini, { apiKey: 'new2' })).toEqual({ provider: 'gemini-api', apiKey: 'new2', baseUrl: 'https://proxy' });
  });
});

describe('validateSettings', () => {
  const cases: Array<[string, SettingsPatch]> = [
    ['ai.temperature', { ai: { temperature: -0.1 } }],
    ['ai.temperature', { ai: { temperature: 2.1 } }],
    ['ai.timeoutMs', { ai: { timeoutMs: 999 } }],
    ['ai.targetLanguage', { ai: { targetLanguage: 'ja' as never } }],
    ['ai.provider', { ai: { provider: { provider: 'openai' as never } } }],
    ['ai.provider.location', { ai: { provider: { provider: 'vertex-ai', location: '', auth: { kind: 'adc' } } } }],
    ['ui.fontScale', { ui: { fontScale: 0.4 } }],
    ['ui.fontScale', { ui: { fontScale: 3.5 } }],
    ['ui.seedColor', { ui: { seedColor: '#12345' } }],
    ['ui.seedColor', { ui: { seedColor: 'red' } }],
    ['ui.appIcon', { ui: { appIcon: 'invalid-icon' as never } }],
    ['downloads.maxActiveDownloads', { downloads: { maxActiveDownloads: 0 } }],
    ['downloads.maxPeersPerTorrent', { downloads: { maxPeersPerTorrent: 0 } }],
    ['anime.repeatCount', { anime: { repeatCount: -1 } }],
    ['manga.preloadPages', { manga: { preloadPages: -1 } }],
  ];

  it.each(cases)('rejects invalid %s with invalid-argument + details.field', (field, patch) => {
    const candidate = deepMerge(defaultSettings(DATA_DIR), patch);
    const error = catchKotori(() => validateSettings(candidate));
    expect(error.code).toBe('invalid-argument');
    expect(error.details).toEqual({ field });
    expect(error.message.startsWith(`${field}:`)).toBe(true);
  });

  it('accepts boundary values', () => {
    const candidate = deepMerge(defaultSettings(DATA_DIR), {
      ai: { temperature: 2, timeoutMs: 1000, targetLanguage: 'en' },
      ui: { fontScale: 0.5, seedColor: '#abcdef', appIcon: 's3-02' },
      downloads: { maxActiveDownloads: 1, maxPeersPerTorrent: 1 },
      anime: { repeatCount: 0 },
      manga: { preloadPages: 0 },
    } satisfies SettingsPatch);
    expect(() => validateSettings(candidate)).not.toThrow();
    expect(() => validateSettings(deepMerge(candidate, { ai: { temperature: 0 }, ui: { fontScale: 3 } }))).not.toThrow();
  });
});

describe('redactSecrets', () => {
  it('masks non-empty secret strings at any depth (incl. arrays) without mutating input', () => {
    const input = {
      ai: { provider: { provider: 'vertex-ai', location: 'global', auth: { kind: 'service-account-json', json: '{"private_key":"x"}' } } },
      gemini: { apiKey: 'AIza-secret', baseUrl: 'https://x' },
      anime: { jimakuApiKey: 'jk', repeatCount: 3 },
      tokens: [{ accessToken: 'ya29' }, { accessToken: '' }],
      emptyKey: { apiKey: '' },
    };
    const snapshot = structuredClone(input);
    const out = redactSecrets(input);
    expect(out).toEqual({
      ai: { provider: { provider: 'vertex-ai', location: 'global', auth: { kind: 'service-account-json', json: '***' } } },
      gemini: { apiKey: '***', baseUrl: 'https://x' },
      anime: { jimakuApiKey: '***', repeatCount: 3 },
      tokens: [{ accessToken: '***' }, { accessToken: '' }],
      emptyKey: { apiKey: '' },
    });
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });

  it('recurses into (rather than masking) non-string values under secret keys and passes primitives through', () => {
    expect(redactSecrets({ json: { apiKey: 'k', other: 1 } })).toEqual({ json: { apiKey: '***', other: 1 } });
    expect(redactSecrets('apiKey')).toBe('apiKey');
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(42)).toBe(42);
  });

  it('redacts a real settings object', () => {
    const store = new SettingsStore(memDb(), DATA_DIR);
    const s = store.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'AIza-real' } }, anime: { jimakuApiKey: 'jimaku-real' } });
    const red = redactSecrets(s);
    expect(red.ai.provider).toEqual({ provider: 'gemini-api', apiKey: '***' });
    expect(red.anime.jimakuApiKey).toBe('***');
    expect(JSON.stringify(red)).not.toMatch(/AIza-real|jimaku-real/);
    expect(s.ai.provider).toEqual({ provider: 'gemini-api', apiKey: 'AIza-real' });
  });
});

describe('SettingsStore', () => {
  it('returns defaults (without writing a row) when nothing is stored', () => {
    const db = memDb();
    const store = new SettingsStore(db, DATA_DIR);
    expect(store.get()).toEqual(defaultSettings(DATA_DIR));
    expect(store.get()).toBe(store.get());
    expect(storedJson(db)).toBeUndefined();
  });

  it('update deep-merges a partial patch, replaces arrays, persists and returns the result', () => {
    const db = memDb();
    const store = new SettingsStore(db, DATA_DIR);
    const next = store.update({ ui: { theme: 'dark' }, anime: { preferredSubtitleLanguages: ['en', 'ja'] } });
    expect(next.ui).toEqual({ ...defaultSettings(DATA_DIR).ui, theme: 'dark' });
    expect(next.anime.preferredSubtitleLanguages).toEqual(['en', 'ja']);
    expect(next.ai).toEqual(defaultSettings(DATA_DIR).ai);
    expect(store.get()).toEqual(next);
    expect(storedJson(db)).toEqual(next);

    const shrunk = store.update({ anime: { preferredSubtitleLanguages: ['ja'] } });
    expect(shrunk.anime.preferredSubtitleLanguages).toEqual(['ja']);
    expect(shrunk.ui.theme).toBe('dark');
  });

  it('switching provider replaces the variant object (no field leaks between providers)', () => {
    const store = new SettingsStore(memDb(), DATA_DIR);
    store.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'AIza', baseUrl: 'https://proxy', apiVersion: 'v1' } } });

    const vertex = store.update({ ai: { provider: { provider: 'vertex-ai', project: 'p', location: 'us-central1', auth: { kind: 'adc' } } } });
    expect(vertex.ai.provider).toEqual({ provider: 'vertex-ai', project: 'p', location: 'us-central1', auth: { kind: 'adc' } });
    expect(vertex.ai.explainModel).toBe('gemini-3.8-flash');

    // Same provider, partial patch → merged (project/auth kept).
    const moved = store.update({ ai: { provider: { location: 'global' } } });
    expect(moved.ai.provider).toEqual({ provider: 'vertex-ai', project: 'p', location: 'global', auth: { kind: 'adc' } });

    // Auth kind switch replaces the auth object too.
    const sa = store.update({ ai: { provider: { auth: { kind: 'service-account-json', json: '{}' } } } });
    expect(sa.ai.provider).toEqual({ provider: 'vertex-ai', project: 'p', location: 'global', auth: { kind: 'service-account-json', json: '{}' } });
    const express = store.update({ ai: { provider: { auth: { kind: 'express-api-key', apiKey: 'ek' } } } });
    expect(express.ai.provider).toMatchObject({ auth: { kind: 'express-api-key', apiKey: 'ek' } });
    expect(JSON.stringify(express.ai.provider)).not.toContain('"json"');

    const back = store.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'new' } } });
    expect(back.ai.provider).toEqual({ provider: 'gemini-api', apiKey: 'new' });
  });

  it('rejects an invalid patch without changing the cached or stored settings', () => {
    const db = memDb();
    const store = new SettingsStore(db, DATA_DIR);
    const before = store.update({ ui: { theme: 'light' } });
    const error = catchKotori(() => store.update({ ui: { theme: 'dark', fontScale: 10 } }));
    expect(error.code).toBe('invalid-argument');
    expect(error.details).toEqual({ field: 'ui.fontScale' });
    expect(store.get()).toEqual(before);
    expect(storedJson(db)).toEqual(before);
    expect(new SettingsStore(db, DATA_DIR).get().ui.theme).toBe('light');
  });

  it('switching to vertex-ai without a location is rejected', () => {
    const store = new SettingsStore(memDb(), DATA_DIR);
    const patch = { ai: { provider: { provider: 'vertex-ai', auth: { kind: 'adc' } } } } as SettingsPatch;
    expect(catchKotori(() => store.update(patch)).details).toEqual({ field: 'ai.provider.location' });
    expect(store.get().ai.provider.provider).toBe('gemini-api');
  });

  it('rejects non-object patches', () => {
    const store = new SettingsStore(memDb(), DATA_DIR);
    for (const bad of [null, 'x', 1, ['a']]) {
      const error = catchKotori(() => store.update(bad as unknown as SettingsPatch));
      expect(error.code).toBe('invalid-argument');
    }
  });

  it('ignores schemaVersion in a patch and undefined values', () => {
    const store = new SettingsStore(memDb(), DATA_DIR);
    const next = store.update({ schemaVersion: 7, ui: { theme: undefined, locale: 'ja' } } as unknown as SettingsPatch);
    expect(next.schemaVersion).toBe(1);
    expect(next.ui.theme).toBe('system');
    expect(next.ui.locale).toBe('ja');
  });

  it('persists across new store instances on the same database', () => {
    const db = memDb();
    new SettingsStore(db, DATA_DIR).update({ ai: { temperature: 1.5 }, library: { animeRoots: ['/a'] } });
    const fresh = new SettingsStore(db, DATA_DIR).get();
    expect(fresh.ai.temperature).toBe(1.5);
    expect(fresh.library.animeRoots).toEqual(['/a']);
  });

  it('persists across re-opening a file database', () => {
    const path = fileDbPath();
    const first = openFile(path);
    new SettingsStore(first, DATA_DIR).update({ ai: { provider: { provider: 'vertex-ai', location: 'global', auth: { kind: 'adc' } } } });
    first.close();
    const second = openFile(path);
    expect(new SettingsStore(second, DATA_DIR).get().ai.provider).toEqual({ provider: 'vertex-ai', location: 'global', auth: { kind: 'adc' } });
  });

  it('forward-migrates a partial stored row: missing fields get defaults, schemaVersion forced to 1', () => {
    const db = memDb();
    db.prepare("INSERT INTO settings (key, json) VALUES ('app', ?)").run(
      JSON.stringify({ ui: { theme: 'dark' }, ai: { provider: { provider: 'vertex-ai', location: 'asia-northeast1', auth: { kind: 'adc' } } } }),
    );
    const s = new SettingsStore(db, '/other/data').get();
    expect(s.schemaVersion).toBe(1);
    expect(s.ui).toEqual({ ...defaultSettings('/other/data').ui, theme: 'dark' });
    expect(s.downloads.downloadDir).toBe(join('/other/data', 'downloads'));
    // Stored vertex variant replaces the gemini default entirely (no empty apiKey leak).
    expect(s.ai.provider).toEqual({ provider: 'vertex-ai', location: 'asia-northeast1', auth: { kind: 'adc' } });
    expect(s.ai.explainModel).toBe('gemini-3.8-flash');
  });

  it('falls back to defaults (and warns) on a corrupt row, then overwrites it on update', () => {
    const db = memDb();
    db.prepare("INSERT INTO settings (key, json) VALUES ('app', '{not json')").run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new SettingsStore(db, DATA_DIR);
    expect(store.get()).toEqual(defaultSettings(DATA_DIR));
    expect(warn).toHaveBeenCalledTimes(1);
    store.update({ ui: { theme: 'dark' } });
    expect(new SettingsStore(db, DATA_DIR).get().ui.theme).toBe('dark');
  });

  it('caches get(): later direct row edits are not observed by the same instance', () => {
    const db = memDb();
    const store = new SettingsStore(db, DATA_DIR);
    store.update({ ui: { theme: 'dark' } });
    db.prepare("UPDATE settings SET json = ? WHERE key = 'app'").run(JSON.stringify({ ui: { theme: 'light' } }));
    expect(store.get().ui.theme).toBe('dark');
    expect(new SettingsStore(db, DATA_DIR).get().ui.theme).toBe('light');
  });
});
