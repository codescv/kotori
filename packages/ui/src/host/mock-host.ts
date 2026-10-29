/**
 * In-memory `PlatformHost` with realistic fixture data for the UI dev harness
 * (`pnpm dev:ui`) and component tests. Implements EVERY `PlatformHost` method:
 *
 * - anime: 2 series × 3 episodes, ASS tracks with dialogue / karaoke / signs;
 * - manga: a `.mokuro` volume (10 pages, vertical bubbles) + a raw volume;
 * - ai: canned + generated `SentenceExplanation`s with a sentence cache,
 *   abortable `explain`, streaming follow-ups, mock VLM OCR / page guide;
 * - downloads: Nyaa / Jimaku / mokuro.moe search and simulated progress with
 *   `download-updated` events (≤ 1 per tick per task) and auto-import;
 * - files: a fake server-side path browser;
 * - dict: seeded Wiktionary JA-ZH / Kanjium pitch / JPDB frequency fixtures
 *   run through the real `@kotori/core` enrichment and click-to-lookup.
 */
import {
  KotoriError,
  type AiConnectionTestResult,
  type AiSettings,
  type AnimeEpisode,
  type AnimeSeries,
  type AppSettings,
  type DownloadRequest,
  type DownloadTask,
  type ExplainRequest,
  type FollowUpMessage,
  type FollowUpRequest,
  type HostCapabilities,
  type HostEvent,
  type HostInfo,
  type Id,
  type MangaBlock,
  type MangaGuideBubble,
  type MangaPage,
  type MangaRect,
  type MangaVolume,
  type ParsedSubtitleTrack,
  type PlatformHost,
  type ScreenApi,
  type SentenceExplanation,
  type SubtitleCue,
  type SubtitleTrack,
} from '@kotori/core';
import { applySettingsPatch, DEFAULT_SETTINGS, mergeDeep } from '../app/default-settings';
import { mockJimakuFiles, mockJimakuSearch, mockListDirectory, mockMokuroCatalog, mockNyaaSearch } from './mock/acquire';
import { createAnimeFixtures } from './mock/anime';
import { createMockDictHost } from './mock/dict-host';
import { explanationFor } from './mock/explanations';
import { bubbleGeometry, createMangaFixtures, type BubbleSpec } from './mock/manga';

export interface MockHostOptions {
  /** Artificial latency per call, ms (default 120). Tests pass 0. */
  readonly latencyMs?: number;
  /** Override capability flags (e.g. `{ streaming: false, vertexAdc: false }`). */
  readonly capabilities?: Partial<HostCapabilities>;
  readonly platform?: HostInfo['platform'];
  /** Initial settings patch. */
  readonly settings?: Parameters<typeof applySettingsPatch>[1];
  /** Download simulation tick (default 500 ms, matching the host contract). */
  readonly downloadTickMs?: number;
  /** Delay between streamed follow-up deltas (default 40 ms). */
  readonly streamDelayMs?: number;
  /** Seed the explanation cache with these sentences (instant hits). */
  readonly precachedSentences?: readonly string[];
  /**
   * Local dictionaries: `'seeded'` (default) = Wiktionary JA-ZH + Kanjium pitch
   * + JPDB frequency fixtures; `'empty'` = `host.dict` with nothing installed;
   * `'absent'` = no `host.dict` at all (legacy hosts).
   */
  readonly dictionaries?: 'seeded' | 'empty' | 'absent';
  /** Optional native screen/orientation controller (Android bridge mock). */
  readonly screen?: ScreenApi | undefined;
}

/** Mock host with test hooks. */
export interface MockPlatformHost extends PlatformHost {
  /** Calls per `area.method` (assert "no network on second click"). */
  readonly calls: Map<string, number>;
  /** Emit an arbitrary host event (tests). */
  emit(event: HostEvent): void;
}

const DEFAULT_CAPS: HostCapabilities = {
  torrent: true,
  embeddedSubtitles: true,
  vertexAdc: true,
  directoryPicker: false,
  filePicker: false,
  pathBrowser: true,
  streaming: true,
  openExternal: true,
};

/** Resolve after `ms`, rejecting with `cancelled` when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new KotoriError('cancelled', 'aborted'));
    if (ms <= 0) return void Promise.resolve().then(resolve);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new KotoriError('cancelled', 'aborted'));
      },
      { once: true },
    );
  });
}

const intersect = (a: MangaRect, b: MangaRect): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

export function createMockPlatformHost(options: MockHostOptions = {}): MockPlatformHost {
  const latency = options.latencyMs ?? 120;
  const tickMs = options.downloadTickMs ?? 500;
  const streamDelay = options.streamDelayMs ?? 40;
  const dictMode = options.dictionaries ?? 'seeded';
  const listeners = new Set<(e: HostEvent) => void>();
  const calls = new Map<string, number>();
  const track = (name: string): void => void calls.set(name, (calls.get(name) ?? 0) + 1);
  const emit = (e: HostEvent): void => listeners.forEach((l) => l(e));
  const delay = (signal?: AbortSignal): Promise<void> => wait(latency, signal);
  const clone = <T>(v: T): T => structuredClone(v);
  let idSeq = 1;
  const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${idSeq++}`;

  // ---------------------------------------------------------------- state
  let settings: AppSettings = options.settings ? applySettingsPatch(DEFAULT_SETTINGS, options.settings) : DEFAULT_SETTINGS;
  const capabilities: HostCapabilities = { ...DEFAULT_CAPS, ...options.capabilities };
  const info: HostInfo = { platform: options.platform ?? 'mock', os: 'linux', version: '0.1.0-mock', capabilities, dataDir: '/home/kotori/.kotori' };

  const series = new Map<Id, AnimeSeries>();
  const episodes = new Map<Id, AnimeEpisode>();
  const tracks = new Map<Id, ParsedSubtitleTrack>();
  const animeFixtures = createAnimeFixtures();
  for (const f of animeFixtures) {
    series.set(f.series.id, f.series);
    for (const e of f.episodes) episodes.set(e.id, e);
    for (const [k, v] of f.cuesByTrack) tracks.set(k, v);
  }
  const volumes = new Map<Id, MangaVolume>();
  const pages = new Map<Id, MangaPage[]>();
  const truth = new Map<Id, readonly (readonly BubbleSpec[])[]>();
  const mangaFixtures = createMangaFixtures();
  for (const f of mangaFixtures) {
    volumes.set(f.volume.id, f.volume);
    pages.set(f.volume.id, f.pages);
    truth.set(f.volume.id, f.truth);
  }
  const explanationCache = new Map<string, SentenceExplanation>();
  const threads = new Map<Id, FollowUpMessage[]>();
  const tasks = new Map<Id, DownloadTask>();
  let ticker: ReturnType<typeof setInterval> | undefined;

  const cacheKey = (sentence: string, lang: string): string => `${lang}\u0000${sentence}`;
  for (const s of options.precachedSentences ?? []) {
    explanationCache.set(cacheKey(s, settings.ai.targetLanguage), { ...explanationFor(s, settings.ai.targetLanguage), fromCache: true });
  }

  const notFound = (what: string, id: string | number): never => {
    throw new KotoriError('not-found', `${what} ${id} not found`);
  };
  const getSeries = (id: Id): AnimeSeries => series.get(id) ?? notFound('series', id);
  const getEpisode = (id: Id): AnimeEpisode => episodes.get(id) ?? notFound('episode', id);
  const getVolume = (id: Id): MangaVolume => volumes.get(id) ?? notFound('volume', id);
  const getPages = (id: Id): MangaPage[] => pages.get(id) ?? notFound('volume', id);
  const findTrack = (trackId: Id): { episode: AnimeEpisode; track: SubtitleTrack } => {
    for (const episode of episodes.values()) {
      const t = episode.subtitleTracks.find((x) => x.id === trackId);
      if (t) return { episode, track: t };
    }
    return notFound('track', trackId);
  };
  const putEpisode = (e: AnimeEpisode): void => void episodes.set(e.id, e);

  // ------------------------------------------------------ library imports
  function importSeriesFrom(path: string, titleOverride?: string, anilistId?: number, coverUrl?: string): AnimeSeries {
    const template = animeFixtures[0];
    if (!template) throw new KotoriError('internal', 'no fixtures');
    const id = newId('series');
    const title = titleOverride || path.split('/').filter(Boolean).pop() || 'Untitled';
    const eps = template.episodes.map((e, i) => {
      const epId = `${id}-ep${i + 1}`;
      const trackMap = new Map<string, string>();
      const subtitleTracks = e.subtitleTracks.map((t) => {
        const tid = `${epId}-${t.id.split('-').pop() ?? 't'}`;
        trackMap.set(t.id, tid);
        return { ...t, id: tid, episodeId: epId };
      });
      for (const [from, to] of trackMap) {
        const parsed = tracks.get(from);
        if (parsed) tracks.set(to, parsed);
      }
      const { progress: _p, ...rest } = e;
      return { ...rest, id: epId, seriesId: id, subtitleTracks, filePath: `${path}/${e.fileName}`, mediaUrl: `mock://media/${epId}` };
    });
    eps.forEach(putEpisode);
    const resolvedCover = coverUrl ?? (anilistId !== undefined ? template.series.coverUrl : undefined);
    const s: AnimeSeries = {
      id,
      title,
      sourcePath: path,
      episodeCount: eps.length,
      addedAt: Date.now(),
      ...(resolvedCover ? { coverUrl: resolvedCover } : {}),
      ...(anilistId !== undefined ? { anilistId } : {}),
    };
    series.set(id, s);
    emit({ type: 'library-changed', scope: 'anime' });
    return s;
  }

  function importVolumeFrom(path: string, titleOverride?: string): MangaVolume {
    const template = mangaFixtures[path.toLowerCase().endsWith('.mokuro') ? 0 : 1] ?? mangaFixtures[0];
    if (!template) throw new KotoriError('internal', 'no fixtures');
    const id = newId('vol');
    const title = titleOverride || (path.split('/').pop() ?? 'Volume').replace(/\.(mokuro|cbz|zip)$/i, '');
    const { progress: _p, ...rest } = template.volume;
    const vol: MangaVolume = { ...rest, id, title, sourcePath: path, addedAt: Date.now() };
    volumes.set(id, vol);
    pages.set(id, clone(template.pages));
    truth.set(id, template.truth);
    emit({ type: 'library-changed', scope: 'manga' });
    return vol;
  }

  // ------------------------------------------------------------ downloads
  const putTask = (task: DownloadTask): DownloadTask => {
    tasks.set(task.id, task);
    emit({ type: 'download-updated', task });
    return task;
  };

  function finishTask(task: DownloadTask): DownloadTask {
    let done: DownloadTask = { ...task, status: 'completed', progress: 1, downloadedBytes: task.totalBytes ?? task.downloadedBytes, speedBps: 0, completedAt: Date.now(), updatedAt: Date.now() };
    const { etaMs: _eta, ...noEta } = done;
    done = noEta;
    const req = task.source;
    if (req.kind === 'mokuro-moe') {
      const vol = importVolumeFrom(`/home/kotori/Manga/${req.volume.name}.mokuro`, req.volume.name);
      done = { ...done, importedVolumeId: vol.id };
    } else if (req.kind === 'torrent') {
      const s = importSeriesFrom(`/home/kotori/Downloads/${req.nyaa?.parsedName.title ?? task.title}`, req.nyaa?.parsedName.title ?? task.title);
      done = { ...done, importedSeriesId: s.id };
    } else if (req.kind === 'jimaku' && req.episodeId && episodes.has(req.episodeId)) {
      const ep = getEpisode(req.episodeId);
      const tid = newId('track');
      const source = ep.subtitleTracks.find((t) => t.language === 'ja' && t.origin !== 'embedded');
      const parsed = source ? tracks.get(source.id) : undefined;
      if (parsed) tracks.set(tid, parsed);
      const newTrack: SubtitleTrack = { id: tid, episodeId: ep.id, origin: 'jimaku', format: req.file.extension === 'srt' ? 'srt' : 'ass', label: `Jimaku · ${req.file.name}`, language: 'ja', filePath: `/home/kotori/.kotori/subtitles/${ep.id}/${req.file.name}`, isDefault: false, cueCount: parsed?.cues.length ?? 0, delayMs: 0 };
      putEpisode({ ...ep, subtitleTracks: [...ep.subtitleTracks, newTrack] });
      done = { ...done, importedTrackId: tid };
      emit({ type: 'library-changed', scope: 'anime' });
    }
    return done;
  }

  function tick(): void {
    let active = 0;
    for (const task of tasks.values()) {
      if (task.status === 'resolving') {
        putTask({ ...task, status: 'downloading', peers: 24, seeds: 18, updatedAt: Date.now(), ...(task.kind === 'torrent' ? { files: [{ index: 0, path: task.title, sizeBytes: task.totalBytes ?? 0, downloadedBytes: 0, selected: true }] } : {}) });
        active++;
      } else if (task.status === 'queued') {
        putTask({ ...task, status: task.kind === 'torrent' ? 'resolving' : 'downloading', updatedAt: Date.now() });
        active++;
      } else if (task.status === 'downloading') {
        const total = task.totalBytes ?? 1;
        const speed = task.kind === 'torrent' ? 42 * 1024 * 1024 : task.kind === 'mokuro-volume' ? 24 * 1024 * 1024 : 2 * 1024 * 1024;
        const step = Math.max(speed * (tickMs / 1000), total * 0.08);
        const downloaded = Math.min(total, task.downloadedBytes + step);
        const progress = downloaded / total;
        if (progress >= 1) {
          putTask({ ...task, status: 'importing', progress: 1, downloadedBytes: total, speedBps: 0, updatedAt: Date.now() });
        } else {
          putTask({ ...task, downloadedBytes: downloaded, progress, speedBps: speed, etaMs: ((total - downloaded) / speed) * 1000, updatedAt: Date.now(), ...(task.files ? { files: task.files.map((f) => ({ ...f, downloadedBytes: downloaded })) } : {}) });
        }
        active++;
      } else if (task.status === 'importing') {
        putTask(finishTask(task));
      }
    }
    if (active === 0 && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  const ensureTicker = (): void => {
    if (!ticker) ticker = setInterval(tick, tickMs);
  };

  // Seed a few historical tasks so the Tasks tab is not empty.
  const seedTask = (t: Omit<DownloadTask, 'createdAt' | 'updatedAt' | 'targetDir'>): void =>
    void tasks.set(t.id, { ...t, targetDir: settings.downloads.downloadDir, createdAt: Date.UTC(2026, 9, 20), updatedAt: Date.UTC(2026, 9, 20) });
  const nyaaSample = mockNyaaSearch({ query: 'Hoshikuzu Radio' });
  if (nyaaSample[0]) {
    seedTask({ id: 'task-seed-1', kind: 'torrent', source: { kind: 'torrent', infoHash: nyaaSample[0].infoHash, magnet: nyaaSample[0].magnet, nyaa: nyaaSample[0] }, title: nyaaSample[0].title, status: 'completed', progress: 1, downloadedBytes: nyaaSample[0].sizeBytes ?? 0, totalBytes: nyaaSample[0].sizeBytes ?? 0, speedBps: 0, completedAt: Date.UTC(2026, 9, 20), importedSeriesId: 'series-hoshikuzu' });
  }
  if (nyaaSample[2]) {
    seedTask({ id: 'task-seed-2', kind: 'torrent', source: { kind: 'torrent', infoHash: nyaaSample[2].infoHash, magnet: nyaaSample[2].magnet, nyaa: nyaaSample[2] }, title: nyaaSample[2].title, status: 'paused', progress: 0.37, downloadedBytes: (nyaaSample[2].sizeBytes ?? 0) * 0.37, totalBytes: nyaaSample[2].sizeBytes ?? 0, speedBps: 0, peers: 0 });
  }
  seedTask({ id: 'task-seed-3', kind: 'http-file', source: { kind: 'http', url: 'https://example.invalid/broken.zip' }, title: 'broken.zip', status: 'failed', progress: 0.12, downloadedBytes: 1_200_000, totalBytes: 10_000_000, speedBps: 0, error: 'HTTP 404 Not Found' });

  // ---------------------------------------------------------------- ai
  function canned(sentence: string): string {
    return sentence.length > 18 ? `${sentence.slice(0, 18)}…` : sentence;
  }

  function answerFor(req: FollowUpRequest): string {
    const s = req.explanation?.sentence ?? '';
    const q = req.question;
    const en = req.targetLanguage === 'en';
    if (/礼貌|polite|丁寧/.test(q)) return en ? `A polite version of “${canned(s)}” would use です／ます, e.g. **ちょっと待ってください**.` : `「${canned(s)}」的礼貌说法可以改成 **です・ます体**，例如：**ちょっと待ってください**。`;
    if (/例句|example|例文/.test(q)) return en ? 'Examples:\n1. **もう食べてんじゃねぇか。** — You’re already eating, aren’t you?\n2. **何してんの？** — What are you doing?' : '例句：\n1. **もう食べてんじゃねぇか。**——你不是已经在吃了吗？\n2. **何してんの？**——你在干嘛？（ている→てる→てん）';
    if (/语气|tone|ニュアンス/.test(q)) return en ? 'The tone is casual and a bit rough; it is typical of close friends or teasing.' : `这句话语气随意、略带粗鲁，常见于熟人之间的吐槽。\`${canned(s)}\` 不适合对上级使用。`;
    return en
      ? `Good question! In “${canned(s)}”, the spoken form contracts the textbook form — see the 🔥 card for each step.`
      : `好问题！在「${canned(s)}」里，口语形是由教科书形缩约而来的：**ている → てる → てん**，**ない → ねぇ**。详见 🔥 口语演变卡片。`;
  }

  async function explainImpl(req: ExplainRequest, signal?: AbortSignal): Promise<SentenceExplanation> {
    track('ai.explain');
    if (settings.ai.provider.provider === 'gemini-api' && settings.ai.provider.apiKey === 'invalid') {
      await delay(signal);
      throw new KotoriError('ai-auth', 'API key not valid. Please pass a valid API key.', { details: { status: 401 } });
    }
    await wait(latency * 4, signal);
    const fresh: SentenceExplanation = { ...explanationFor(req.sentence, req.targetLanguage), createdAt: Date.now(), fromCache: false };
    if (settings.ai.cacheEnabled) explanationCache.set(cacheKey(req.sentence, req.targetLanguage), { ...fresh, fromCache: true });
    return fresh;
  }

  // ---------------------------------------------------------------- host
  const host: MockPlatformHost = {
    info,
    calls,
    emit,
    settings: {
      async get() {
        track('settings.get');
        await delay();
        return settings;
      },
      async update(patch) {
        track('settings.update');
        await delay();
        settings = applySettingsPatch(settings, patch);
        emit({ type: 'settings-changed', settings });
        return settings;
      },
      async testAi(candidate?: AiSettings): Promise<AiConnectionTestResult> {
        track('settings.testAi');
        const ai = candidate ?? settings.ai;
        await wait(latency * 3);
        const p = ai.provider;
        const fail = (message: string): AiConnectionTestResult => ({ ok: false, model: ai.explainModel, latencyMs: latency * 3, message });
        if (p.provider === 'gemini-api') {
          if (!p.apiKey.trim()) return fail('API key is empty');
          if (p.apiKey === 'invalid') return fail('401 API key not valid');
        } else {
          if (!p.location.trim()) return fail('location is required');
          if (p.auth.kind !== 'express-api-key' && !p.project?.trim()) return fail('project is required');
          if (p.auth.kind === 'adc' && !capabilities.vertexAdc) return fail('ADC is not available on this host');
          if (p.auth.kind === 'access-token' && !p.auth.accessToken.trim()) return fail('access token is empty');
          if (p.auth.kind === 'express-api-key' && !p.auth.apiKey.trim()) return fail('API key is empty');
          if (p.auth.kind === 'service-account-json' && !/"private_key"/.test(p.auth.json)) return fail('service account JSON has no private_key');
        }
        return { ok: true, model: ai.explainModel, latencyMs: 380 + latency, message: 'こんにちは！' };
      },
    },

    anime: {
      async listSeries() {
        track('anime.listSeries');
        await delay();
        return [...series.values()].sort((a, b) => (b.lastWatchedAt ?? b.addedAt) - (a.lastWatchedAt ?? a.addedAt));
      },
      async getSeries(id) {
        await delay();
        return getSeries(id);
      },
      async listEpisodes(seriesId) {
        track('anime.listEpisodes');
        await delay();
        getSeries(seriesId);
        return [...episodes.values()].filter((e) => e.seriesId === seriesId).sort((a, b) => (a.parsedName.episode ?? 0) - (b.parsedName.episode ?? 0));
      },
      async getEpisode(id) {
        await delay();
        return getEpisode(id);
      },
      async importSeries(req) {
        track('anime.importSeries');
        await wait(latency * 3);
        if (!req.path.trim()) throw new KotoriError('invalid-argument', 'path is required');
        return importSeriesFrom(req.path, req.titleOverride, req.anilistId, req.coverUrl);
      },
      async updateSeries(seriesId, patch) {
        track('anime.updateSeries');
        await delay();
        const cur = getSeries(seriesId);
        const nextTitle = patch.title !== undefined && patch.title.trim() !== '' ? patch.title.trim() : cur.title;
        const nextAnilistId = patch.anilistId === null ? undefined : (patch.anilistId ?? cur.anilistId);
        const nextCoverUrl =
          patch.coverUrl === null || (typeof patch.coverUrl === 'string' && patch.coverUrl.trim() === '')
            ? undefined
            : typeof patch.coverUrl === 'string'
              ? patch.coverUrl.trim()
              : cur.coverUrl;
        const { anilistId: _a, coverUrl: _c, ...rest } = cur;
        const updated: AnimeSeries = {
          ...rest,
          title: nextTitle,
          ...(nextAnilistId !== undefined ? { anilistId: nextAnilistId } : {}),
          ...(nextCoverUrl !== undefined ? { coverUrl: nextCoverUrl } : {}),
        };
        series.set(seriesId, updated);
        emit({ type: 'library-changed', scope: 'anime' });
        return updated;
      },
      async removeSeries(seriesId) {
        await delay();
        getSeries(seriesId);
        series.delete(seriesId);
        for (const e of [...episodes.values()]) if (e.seriesId === seriesId) episodes.delete(e.id);
        emit({ type: 'library-changed', scope: 'anime' });
      },
      async rescanSeries(seriesId) {
        await wait(latency * 2);
        const s = getSeries(seriesId);
        emit({ type: 'library-changed', scope: 'anime' });
        return s;
      },
      async getCues(trackId) {
        track('anime.getCues');
        await delay();
        const { track: t } = findTrack(trackId);
        const parsed = tracks.get(trackId);
        if (!parsed) throw new KotoriError(t.origin === 'embedded' ? 'unsupported' : 'not-found', t.origin === 'embedded' ? 'extract the embedded track first' : `cues for ${trackId} not found`);
        if (!t.delayMs) return parsed;
        const cues: SubtitleCue[] = parsed.cues.map((c) => ({ ...c, startMs: c.startMs + t.delayMs, endMs: c.endMs + t.delayMs }));
        return { ...parsed, cues };
      },
      async addSubtitleTrack(episodeId, input) {
        await delay();
        const ep = getEpisode(episodeId);
        const id = newId('track');
        const format = /\.srt$/i.test(input.fileName) ? 'srt' : /\.vtt$/i.test(input.fileName) ? 'vtt' : 'ass';
        const source = ep.subtitleTracks.find((t) => tracks.has(t.id));
        const parsed: ParsedSubtitleTrack = input.content
          ? { info: { format, encoding: 'utf-8' }, cues: input.content.split(/\r?\n/).filter(Boolean).map((text, index) => ({ index, startMs: index * 3000, endMs: index * 3000 + 2500, text, rawText: text })), warnings: [] }
          : (source && tracks.get(source.id)) || { info: { format, encoding: 'utf-8' }, cues: [], warnings: [] };
        tracks.set(id, parsed);
        const t: SubtitleTrack = { id, episodeId, origin: 'imported', format, label: input.fileName, ...(input.language ? { language: input.language } : {}), ...(input.path ? { filePath: input.path } : {}), isDefault: false, cueCount: parsed.cues.length, delayMs: 0 };
        putEpisode({ ...ep, subtitleTracks: [...ep.subtitleTracks, t] });
        return t;
      },
      async extractEmbeddedTrack(episodeId, streamIndex) {
        track('anime.extractEmbeddedTrack');
        if (!capabilities.embeddedSubtitles) throw new KotoriError('unsupported', 'ffmpeg not available');
        await wait(latency * 4);
        const ep = getEpisode(episodeId);
        const emb = ep.subtitleTracks.find((t) => t.origin === 'embedded' && t.streamIndex === streamIndex) ?? notFound('stream', streamIndex);
        const source = ep.subtitleTracks.find((t) => t.origin !== 'embedded' && tracks.has(t.id));
        const parsed = source ? tracks.get(source.id) : undefined;
        if (parsed) tracks.set(emb.id, parsed);
        const extracted: SubtitleTrack = { ...emb, filePath: `/home/kotori/.kotori/subtitles/${episodeId}/stream${streamIndex}.ass`, label: `${emb.label} · extracted`, cueCount: parsed?.cues.length ?? 0 };
        putEpisode({ ...ep, subtitleTracks: ep.subtitleTracks.map((t) => (t.id === emb.id ? extracted : t)) });
        return extracted;
      },
      async removeSubtitleTrack(trackId) {
        await delay();
        const { episode } = findTrack(trackId);
        putEpisode({ ...episode, subtitleTracks: episode.subtitleTracks.filter((t) => t.id !== trackId) });
        tracks.delete(trackId);
      },
      async setTrackDelay(trackId, delayMs) {
        await delay();
        const { episode, track: t } = findTrack(trackId);
        const updated = { ...t, delayMs };
        putEpisode({ ...episode, subtitleTracks: episode.subtitleTracks.map((x) => (x.id === trackId ? updated : x)) });
        return updated;
      },
      async setDefaultTrack(episodeId, trackId) {
        await delay();
        const ep = getEpisode(episodeId);
        putEpisode({ ...ep, subtitleTracks: ep.subtitleTracks.map((t) => ({ ...t, isDefault: t.id === trackId })) });
      },
      async saveProgress(episodeId, progress) {
        track('anime.saveProgress');
        const ep = episodes.get(episodeId);
        if (!ep) return;
        putEpisode({ ...ep, progress });
        const s = series.get(ep.seriesId);
        if (s) series.set(s.id, { ...s, lastWatchedEpisodeId: episodeId, lastWatchedAt: progress.updatedAt });
      },
      async autoFetchJimaku(seriesId, opts) {
        track('anime.autoFetchJimaku');
        await delay();
        const s = getSeries(seriesId);
        const entryId = opts?.entryId ?? s.jimakuEntryId ?? mockJimakuSearch(s.title)[0]?.id;
        const entry = mockJimakuSearch(undefined).find((e) => e.id === entryId);
        if (!entry) throw new KotoriError('not-found', `no Jimaku entry for ${s.title}`);
        const files = mockJimakuFiles(entry.id).filter((f) => f.extension === 'ass');
        const eps = [...episodes.values()].filter((e) => e.seriesId === seriesId);
        const out: DownloadTask[] = [];
        for (const ep of eps) {
          const file = files.find((f) => f.episode === ep.parsedName.episode);
          if (file) out.push(await host.downloads.start({ source: { kind: 'jimaku', entry, file, episodeId: ep.id, seriesId }, autoImport: true }));
        }
        return out;
      },
    },

    manga: {
      async listVolumes() {
        track('manga.listVolumes');
        await delay();
        return [...volumes.values()];
      },
      async getVolume(id) {
        await delay();
        return getVolume(id);
      },
      async importVolume(req) {
        track('manga.importVolume');
        await wait(latency * 3);
        if (!req.path.trim()) throw new KotoriError('invalid-argument', 'path is required');
        return importVolumeFrom(req.path, req.titleOverride);
      },
      async removeVolume(id) {
        await delay();
        getVolume(id);
        volumes.delete(id);
        pages.delete(id);
        emit({ type: 'library-changed', scope: 'manga' });
      },
      async getPage(id, index) {
        await delay();
        return getPages(id)[index] ?? notFound('page', index);
      },
      async getPages(id) {
        track('manga.getPages');
        await delay();
        return getPages(id);
      },
      async setReadingMode(id, mode) {
        await delay();
        const v = getVolume(id);
        const { readingMode: _r, ...rest } = v;
        const updated: MangaVolume = mode ? { ...rest, readingMode: mode } : rest;
        volumes.set(id, updated);
        return updated;
      },
      async setCoverIsSingle(id, single) {
        await delay();
        const updated = { ...getVolume(id), coverIsSingle: single };
        volumes.set(id, updated);
        return updated;
      },
      async saveProgress(id, progress) {
        track('manga.saveProgress');
        const v = volumes.get(id);
        if (v) volumes.set(id, { ...v, progress });
      },
      async addBlocks(id, pageIndex, blocks) {
        track('manga.addBlocks');
        await delay();
        const list = getPages(id);
        const page = list[pageIndex] ?? notFound('page', pageIndex);
        const added: MangaBlock[] = blocks.map((b, i) => ({ ...b, index: page.blocks.length + i, zIndex: page.blocks.length + i }));
        const updated: MangaPage = { ...page, blocks: [...page.blocks, ...added] };
        list[pageIndex] = updated;
        return updated;
      },
    },

    ai: {
      async explain(req, opts) {
        return explainImpl(req, opts?.signal);
      },
      async explainBatch(reqs, opts) {
        track('ai.explainBatch');
        const out: SentenceExplanation[] = [];
        for (const r of reqs) {
          if (opts?.signal?.aborted) throw new KotoriError('cancelled', 'Cancelled');
          const cached = !r.force && settings.ai.cacheEnabled ? explanationCache.get(cacheKey(r.sentence, r.targetLanguage)) : undefined;
          if (cached) {
            out.push(cached);
          } else {
            await wait(latency * 2, opts?.signal);
            const fresh: SentenceExplanation = { ...explanationFor(r.sentence, r.targetLanguage), createdAt: Date.now(), fromCache: false };
            if (settings.ai.cacheEnabled) explanationCache.set(cacheKey(r.sentence, r.targetLanguage), { ...fresh, fromCache: true });
            out.push(fresh);
          }
        }
        return out;
      },
      async getCachedExplanation(req) {
        track('ai.getCachedExplanation');
        if (req.force || !settings.ai.cacheEnabled) return undefined;
        return explanationCache.get(cacheKey(req.sentence, req.targetLanguage));
      },
      async followUp(req, opts) {
        track('ai.followUp');
        await wait(latency * 3, opts?.signal);
        const msg: FollowUpMessage = { id: newId('msg'), role: 'model', text: answerFor(req), createdAt: Date.now(), usage: { promptTokens: 420, outputTokens: 96 } };
        const thread = threads.get(req.explanationId) ?? [];
        thread.push({ id: newId('msg'), role: 'user', text: req.question, createdAt: Date.now() }, msg);
        threads.set(req.explanationId, thread);
        return msg;
      },
      async followUpStream(req, onDelta, opts) {
        track('ai.followUpStream');
        const text = answerFor(req);
        const messageId = newId('msg');
        await wait(latency, opts?.signal);
        const pieces = text.match(/.{1,6}/gsu) ?? [text];
        for (const piece of pieces) {
          await wait(streamDelay, opts?.signal);
          onDelta({ messageId, textDelta: piece, done: false });
        }
        onDelta({ messageId, textDelta: '', done: true, usage: { promptTokens: 420, outputTokens: 96 } });
        const msg: FollowUpMessage = { id: messageId, role: 'model', text, createdAt: Date.now(), usage: { promptTokens: 420, outputTokens: 96 } };
        const thread = threads.get(req.explanationId) ?? [];
        thread.push({ id: newId('msg'), role: 'user', text: req.question, createdAt: Date.now() }, msg);
        threads.set(req.explanationId, thread);
        return msg;
      },
      async ocrBubble(req, opts) {
        track('ai.ocrBubble');
        await wait(latency * 5, opts?.signal);
        const bubbles = truth.get(req.volumeId)?.[req.pageIndex] ?? [];
        let best: BubbleSpec | undefined;
        let bestArea = 0;
        for (const b of bubbles) {
          const a = intersect(bubbleGeometry(b).rect, req.rect);
          if (a > bestArea) {
            bestArea = a;
            best = b;
          }
        }
        const lines = best ? [...best.lines] : ['……'];
        const text = lines.join('');
        const explanation = req.explain && best ? await explainImpl({ sentence: text, source: { kind: 'manga', volumeId: req.volumeId, pageIndex: req.pageIndex }, targetLanguage: req.targetLanguage }, opts?.signal) : undefined;
        return {
          volumeId: req.volumeId,
          pageIndex: req.pageIndex,
          rect: req.rect,
          lines,
          text,
          vertical: true,
          confidence: best ? 0.93 : 0.1,
          ...(explanation ? { explanation } : {}),
          model: settings.ai.visionModel,
          createdAt: Date.now(),
          usage: { promptTokens: 1290, outputTokens: 210 },
        };
      },
      async pageGuide(req, opts) {
        track('ai.pageGuide');
        await wait(latency * 6, opts?.signal);
        const page = getPages(req.volumeId)[req.pageIndex] ?? notFound('page', req.pageIndex);
        const specs = truth.get(req.volumeId)?.[req.pageIndex] ?? [];
        const items = specs.map((b, i) => ({ b, rect: bubbleGeometry(b).rect, blockIndex: page.blocks.length > i ? i : undefined }));
        // Japanese reading order: top band first, then right → left.
        items.sort((a, b) => (Math.abs(a.rect.top - b.rect.top) > page.height * 0.2 ? a.rect.top - b.rect.top : b.rect.right - a.rect.right));
        const bubblesOut: MangaGuideBubble[] = items.map((it, i) => ({
          order: i + 1,
          rectFraction: { left: it.rect.left / page.width, top: it.rect.top / page.height, right: it.rect.right / page.width, bottom: it.rect.bottom / page.height },
          ...(it.blockIndex !== undefined ? { blockIndex: it.blockIndex } : {}),
          text: it.b.lines.join(''),
          ...(it.b.speaker ? { speaker: it.b.speaker } : {}),
          translation: it.b.translation ?? '',
          note: i === 0 ? '注意句末语气词带来的情绪变化。' : '',
        }));
        return {
          volumeId: req.volumeId,
          pageIndex: req.pageIndex,
          bubbles: bubblesOut,
          summary: bubblesOut.length ? `本页共有 ${bubblesOut.length} 个对白气泡，主要是角色之间轻松的日常对话。` : '本页没有对白，是一张氛围插图。',
          model: settings.ai.visionModel,
          createdAt: Date.now(),
          usage: { promptTokens: 2580, outputTokens: 420 },
        };
      },
      async getThread(explanationId) {
        track('ai.getThread');
        return threads.get(explanationId) ?? [];
      },
      async clearCache() {
        await delay();
        const removed = explanationCache.size;
        explanationCache.clear();
        return { removed };
      },
    },

    downloads: {
      async searchNyaa(q) {
        track('downloads.searchNyaa');
        await wait(latency * 3);
        return mockNyaaSearch(q);
      },
      async searchJimaku(q) {
        track('downloads.searchJimaku');
        await wait(latency * 2);
        if (!settings.anime.jimakuApiKey.trim()) throw new KotoriError('ai-auth', 'Jimaku API key missing', { details: { service: 'jimaku' } });
        return mockJimakuSearch(q.query, q.anilistId);
      },
      async listJimakuFiles(entryId, episode) {
        await wait(latency * 2);
        return mockJimakuFiles(entryId, episode);
      },
      async browseMokuroCatalog(url) {
        track('downloads.browseMokuroCatalog');
        await wait(latency * 2);
        return mockMokuroCatalog(url);
      },
      async list() {
        await delay();
        return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
      },
      async get(id) {
        await delay();
        return tasks.get(id) ?? notFound('task', id);
      },
      async start(req: DownloadRequest) {
        track('downloads.start');
        await delay();
        const src = req.source;
        if (src.kind === 'torrent' && !capabilities.torrent) throw new KotoriError('unsupported', 'torrent engine not available on this host');
        const kind = src.kind === 'torrent' ? 'torrent' : src.kind === 'jimaku' ? 'jimaku-subtitle' : src.kind === 'mokuro-moe' ? 'mokuro-volume' : 'http-file';
        const title = req.title ?? (src.kind === 'torrent' ? (src.nyaa?.title ?? src.infoHash) : src.kind === 'jimaku' ? src.file.name : src.kind === 'mokuro-moe' ? src.volume.name : (src.fileName ?? src.url));
        const totalBytes = src.kind === 'torrent' ? (src.nyaa?.sizeBytes ?? 1_000_000_000) : src.kind === 'jimaku' ? (src.file.sizeBytes ?? 40_000) : src.kind === 'mokuro-moe' ? (src.volume.sizeBytes ?? 80_000_000) : 10_000_000;
        const now = Date.now();
        const task: DownloadTask = { id: newId('task'), kind, source: src, title, status: 'queued', progress: 0, downloadedBytes: 0, totalBytes, speedBps: 0, targetDir: req.targetDir ?? settings.downloads.downloadDir, createdAt: now, updatedAt: now };
        putTask(task);
        ensureTicker();
        return task;
      },
      async pause(id) {
        await delay();
        const t = tasks.get(id) ?? notFound('task', id);
        return putTask({ ...t, status: 'paused', speedBps: 0, updatedAt: Date.now() });
      },
      async resume(id) {
        await delay();
        const t = tasks.get(id) ?? notFound('task', id);
        const resumed = putTask({ ...t, status: 'downloading', updatedAt: Date.now() });
        ensureTicker();
        return resumed;
      },
      async cancel(id) {
        await delay();
        const t = tasks.get(id) ?? notFound('task', id);
        return putTask({ ...t, status: 'cancelled', speedBps: 0, updatedAt: Date.now() });
      },
      async remove(id) {
        await delay();
        tasks.delete(id);
        emit({ type: 'download-removed', taskId: id });
      },
      async selectFiles(id, fileIndexes) {
        await delay();
        const t = tasks.get(id) ?? notFound('task', id);
        return putTask({ ...t, files: (t.files ?? []).map((f) => ({ ...f, selected: fileIndexes.includes(f.index) })), updatedAt: Date.now() });
      },
    },

    files: {
      ...(capabilities.pathBrowser
        ? {
            async listDirectory(path?: string) {
              track('files.listDirectory');
              await delay();
              return mockListDirectory(path);
            },
          }
        : {}),
      ...(capabilities.directoryPicker
        ? {
            async pickDirectory() {
              await delay();
              return 'content://com.android.externalstorage.documents/tree/primary%3AAnime%2FNatsuzora';
            },
          }
        : {}),
      ...(capabilities.filePicker
        ? {
            async pickFiles() {
              await delay();
              return ['content://com.android.externalstorage.documents/document/primary%3AManga%2Fvolume.cbz'];
            },
          }
        : {}),
      ...(capabilities.openExternal
        ? {
            async openExternal(url: string) {
              track('files.openExternal');
              emit({ type: 'host-notice', level: 'info', message: `openExternal: ${url.slice(0, 60)}…` });
            },
          }
        : {}),
    },

    ...(dictMode !== 'absent' ? { dict: createMockDictHost({ seeded: dictMode === 'seeded', delay: () => delay(), emit, track, newId }) } : {}),
    ...(options.screen ? { screen: options.screen } : {}),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async dispose() {
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      listeners.clear();
    },
  };
  return host;
}

export { mergeDeep };
