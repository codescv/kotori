import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiApi, AnimeApi, DictionaryHost, DownloadsApi, HostEvent, MangaApi, SettingsApi } from '@kotori/core';
import { defaultSettings, deepMerge, mergeSettings } from './settings';
import { DATA_ROOT, createTestHost, type TestHost } from './testing/harness';

const open: TestHost[] = [];
async function makeHost(...args: Parameters<typeof createTestHost>): Promise<TestHost> {
  const t = await createTestHost(...args);
  open.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.host.dispose()));
});

// Compile-time exhaustive method lists: adding a method to a PlatformHost API
// without updating these lists fails typecheck (Record<keyof Api, true>).
const SETTINGS_METHODS: Record<keyof SettingsApi, true> = { get: true, update: true, testAi: true };
const ANIME_METHODS: Record<keyof AnimeApi, true> = {
  listSeries: true,
  getSeries: true,
  listEpisodes: true,
  getEpisode: true,
  importSeries: true,
  updateSeries: true,
  removeSeries: true,
  rescanSeries: true,
  getCues: true,
  addSubtitleTrack: true,
  extractEmbeddedTrack: true,
  removeSubtitleTrack: true,
  setTrackDelay: true,
  setDefaultTrack: true,
  saveProgress: true,
  autoFetchJimaku: true,
};
const MANGA_METHODS: Record<keyof MangaApi, true> = {
  listVolumes: true,
  getVolume: true,
  importVolume: true,
  removeVolume: true,
  getPage: true,
  getPages: true,
  setReadingMode: true,
  setCoverIsSingle: true,
  saveProgress: true,
  addBlocks: true,
};
const AI_METHODS: Record<keyof AiApi, true> = {
  explain: true,
  explainBatch: true,
  getCachedExplanation: true,
  followUp: true,
  followUpStream: true,
  ocrBubble: true,
  pageGuide: true,
  getThread: true,
  clearCache: true,
};
const DOWNLOAD_METHODS: Record<keyof DownloadsApi, true> = {
  searchNyaa: true,
  searchJimaku: true,
  listJimakuFiles: true,
  browseMokuroCatalog: true,
  list: true,
  get: true,
  start: true,
  pause: true,
  resume: true,
  cancel: true,
  remove: true,
  selectFiles: true,
};
const DICT_METHODS: Record<keyof DictionaryHost, true> = {
  list: true,
  importZip: true,
  update: true,
  remove: true,
  enrichVocab: true,
  lookupPrefix: true,
};

describe('createCapacitorPlatformHost', () => {
  it('reports android info and capabilities', async () => {
    const { host } = await makeHost();
    expect(host.info).toEqual({
      platform: 'android',
      os: 'android',
      version: 'test',
      dataDir: DATA_ROOT,
      capabilities: {
        torrent: true,
        embeddedSubtitles: false,
        vertexAdc: false,
        directoryPicker: true,
        filePicker: true,
        pathBrowser: false,
        streaming: true,
        openExternal: true,
      },
    });
  });

  it('implements every method of every API group', async () => {
    const { host } = await makeHost();
    const groups: [object, Record<string, true>][] = [
      [host.settings, SETTINGS_METHODS],
      [host.anime, ANIME_METHODS],
      [host.manga, MANGA_METHODS],
      [host.ai, AI_METHODS],
      [host.downloads, DOWNLOAD_METHODS],
      [host.dict ?? {}, DICT_METHODS],
    ];
    for (const [api, methods] of groups) {
      for (const name of Object.keys(methods)) expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(typeof host.subscribe).toBe('function');
    expect(typeof host.dispose).toBe('function');
  });

  it('maps files API to injected pickers / openExternal and omits listDirectory', async () => {
    const pickDirectory = vi.fn(() => Promise.resolve('content://tree/primary%3AAnime'));
    const pickFiles = vi.fn(() => Promise.resolve(['file:///sdcard/a.srt']));
    const openExternal = vi.fn(() => Promise.resolve());
    const { host } = await makeHost({ pickDirectory, pickFiles, openExternal });
    expect(host.files.listDirectory).toBeUndefined();
    await expect(host.files.pickDirectory?.()).resolves.toBe('content://tree/primary%3AAnime');
    await expect(host.files.pickFiles?.({ accept: ['.srt'], multiple: true })).resolves.toEqual(['file:///sdcard/a.srt']);
    expect(pickFiles).toHaveBeenCalledWith({ accept: ['.srt'], multiple: true });
    await host.files.openExternal?.('https://jimaku.cc');
    expect(openExternal).toHaveBeenCalledWith('https://jimaku.cc');
  });

  it('rejects with KotoriError codes for missing records', async () => {
    const { host } = await makeHost();
    await expect(host.anime.getSeries('nope')).rejects.toMatchObject({ code: 'not-found' });
    await expect(host.manga.getVolume('nope')).rejects.toMatchObject({ code: 'not-found' });
    await expect(host.downloads.get('nope')).rejects.toMatchObject({ code: 'not-found' });
    await expect(host.anime.extractEmbeddedTrack('e', 2)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('subscribe/unsubscribe and dispose are idempotent', async () => {
    const { host } = await makeHost();
    const events: HostEvent[] = [];
    const off = host.subscribe((e) => events.push(e));
    await host.settings.update({ ui: { theme: 'dark' } });
    off();
    await host.settings.update({ ui: { theme: 'light' } });
    expect(events).toHaveLength(1);
    await host.dispose();
    await host.dispose();
  });
});

describe('settings', () => {
  it('defaults match the desktop host', async () => {
    const { host } = await makeHost();
    const s = await host.settings.get();
    expect(s).toEqual(defaultSettings(`${DATA_ROOT}/downloads`));
    expect(s.ai).toMatchObject({
      provider: { provider: 'gemini-api', apiKey: '' },
      explainModel: 'gemini-3.5-flash-lite',
      visionModel: 'gemini-3.5-flash-lite',
      temperature: 0.2,
      targetLanguage: 'zh-CN',
      cacheEnabled: true,
      timeoutMs: 30000,
    });
    expect(s.ui).toEqual({ theme: 'system', seedColor: '#8ab49a', locale: 'zh-CN', fontScale: 1 });
    expect(s.anime).toMatchObject({ mergeKaraokeCues: true, hideSigns: true, repeatCount: 3, seekPaddingMs: 250 });
    expect(s.manga.defaultReadingMode).toBe('spread-rtl');
    expect(s.downloads).toMatchObject({
      maxActiveDownloads: 3,
      maxPeersPerTorrent: 50,
      seedAfterComplete: false,
      nyaaBaseUrl: 'https://nyaa.si',
      mokuroCatalogUrl: 'https://mokuro.moe/manga/',
    });
  });

  it('deep-merges patches, emits settings-changed and persists', async () => {
    const t = await makeHost();
    const events: HostEvent[] = [];
    t.host.subscribe((e) => events.push(e));
    const next = await t.host.settings.update({ ai: { temperature: 0.5 }, anime: { preferredSubtitleLanguages: ['ja', 'en'] } });
    expect(next.ai.temperature).toBe(0.5);
    expect(next.ai.explainModel).toBe('gemini-3.5-flash-lite');
    expect(next.anime.preferredSubtitleLanguages).toEqual(['ja', 'en']);
    expect(next.anime.repeatCount).toBe(3);
    expect(events).toEqual([{ type: 'settings-changed', settings: next }]);
    await t.host.dispose();
    const again = await makeHost({}, { fs: t.fs, idbFactory: t.idbFactory, clock: t.clock });
    expect((await again.host.settings.get()).ai.temperature).toBe(0.5);
  });

  it('replaces discriminated unions when the discriminant changes', async () => {
    const { host } = await makeHost();
    const vertex = await host.settings.update({
      ai: { provider: { provider: 'vertex-ai', location: 'global', auth: { kind: 'express-api-key', apiKey: 'k' } } },
    });
    expect(vertex.ai.provider).toEqual({ provider: 'vertex-ai', location: 'global', auth: { kind: 'express-api-key', apiKey: 'k' } });
    const token = await host.settings.update({ ai: { provider: { provider: 'vertex-ai', project: 'p', auth: { kind: 'access-token', accessToken: 't' } } } });
    expect(token.ai.provider).toEqual({ provider: 'vertex-ai', project: 'p', location: 'global', auth: { kind: 'access-token', accessToken: 't' } });
    const back = await host.settings.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'g' } } });
    expect(back.ai.provider).toEqual({ provider: 'gemini-api', apiKey: 'g' });
  });

  it('mergeSettings never changes schemaVersion and ignores undefined', () => {
    const base = defaultSettings('/d');
    expect(mergeSettings(base, {}).schemaVersion).toBe(1);
    expect(deepMerge({ a: 1, b: { c: 2 } }, { b: { c: undefined, d: 3 } })).toEqual({ a: 1, b: { c: 2, d: 3 } });
  });

  it('invokes setAppIcon when ui.appIcon changes in settings.update', async () => {
    const setAppIcon = vi.fn(() => Promise.resolve());
    const { host } = await makeHost({ setAppIcon });
    await host.settings.update({ ui: { theme: 'dark' } });
    expect(setAppIcon).not.toHaveBeenCalled();

    const updated = await host.settings.update({ ui: { appIcon: 's3-02' } });
    expect(updated.ui.appIcon).toBe('s3-02');
    expect(setAppIcon).toHaveBeenCalledTimes(1);
    expect(setAppIcon).toHaveBeenCalledWith('s3-02');

    await host.settings.update({ ui: { appIcon: 's3-02' } });
    expect(setAppIcon).toHaveBeenCalledTimes(1);
  });

  it('testAi reports failure instead of throwing', async () => {
    const { host } = await makeHost();
    const result = await host.settings.testAi();
    expect(result.ok).toBe(false);
    expect(result.model).toBe('gemini-3.5-flash-lite');
    expect(result.message).toMatch(/^[a-z-]+: /);
  });
});
