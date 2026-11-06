/**
 * Global 「缓存AI解读」 job store + runner.
 *
 * Jobs live outside any screen, so caching keeps running while the user moves
 * between Player / Reader / Library / Downloads / Settings. One job runs at a
 * time (others wait as `queued`, e.g. 「缓存全季解读」), each job using the
 * runner's own bounded LLM concurrency. Per target (`anime:<episodeId>` /
 * `manga:<volumeId>`) the store tracks phase + progress and an
 * `AbortController` for 1-tap cancel; `cachedTags` / `cachingTags` (sentence
 * tags, see {@link cacheTag}) let the transcript light up `✦` / `◌` in real
 * time as chunks finish.
 */
import { create } from 'zustand';
import type { ExplainRequest, Id, ImagePayload, MangaPage, PlatformHost, TargetLanguage } from '@kotori/core';
import { createTranslator } from '../../i18n';
import { buildTranscriptRows } from '../../lib/cues';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { downscalePageImage } from '../manga/reader/crop';
import { collectGuideBubbleRequests, collectMangaBlockRequests, collectSubtitleRequests } from './collect';
import { abortableSleep, runExplainCache, type ChunkOutcome } from './runner';
import { resolveCacheTrack } from './tracks';

export type AiCachePhase = 'queued' | 'checking' | 'ocr' | 'explaining' | 'done' | 'cancelled' | 'error';

export type AiCacheTarget =
  | { readonly kind: 'anime'; readonly episodeId: Id; readonly trackId?: Id | undefined; readonly title?: string | undefined }
  | { readonly kind: 'manga'; readonly volumeId: Id; readonly title?: string | undefined };

export interface AiCacheJob {
  readonly key: string;
  readonly target: AiCacheTarget;
  readonly title: string;
  readonly phase: AiCachePhase;
  /** Unique explainable sentences of the target. */
  readonly totalItems: number;
  /** Already cached when the job started (0 tokens). */
  readonly cachedInitially: number;
  /** Explained + cached by this job. */
  readonly completedItems: number;
  readonly failedItems: number;
  /** Raw manga pages needing `ai.pageGuide` (OCR) / done so far. */
  readonly ocrTotal: number;
  readonly ocrDone: number;
  readonly trackId?: Id | undefined;
  readonly errorMessage?: string | undefined;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
}

export interface AiCacheState {
  readonly jobs: Readonly<Record<string, AiCacheJob>>;
  /** Sentence tags cached by jobs this session (`✦`). */
  readonly cachedTags: ReadonlySet<string>;
  /** Sentence tags in flight right now (`◌`). */
  readonly cachingTags: ReadonlySet<string>;
  /** Start (or resume) caching a target; no-op while it is already queued / running. */
  start(host: PlatformHost, target: AiCacheTarget): void;
  /** Cancel a queued / running job (already cached sentences are kept). */
  cancel(key: string): void;
  /** Start when idle, cancel when active. */
  toggle(host: PlatformHost, target: AiCacheTarget): void;
  /** Forget a finished job. */
  dismiss(key: string): void;
  reset(): void;
}

export const aiCacheKey = (target: AiCacheTarget): string => (target.kind === 'anime' ? `anime:${target.episodeId}` : `manga:${target.volumeId}`);

export const isActivePhase = (phase: AiCachePhase | undefined): boolean =>
  phase === 'queued' || phase === 'checking' || phase === 'ocr' || phase === 'explaining';

/** Session-local identity of one cached sentence (same inputs as the cache key, minus prompt version). */
export const cacheTag = (sentence: string, targetLanguage: TargetLanguage, model: string): string => `${targetLanguage}\u0000${model}\u0000${sentence}`;

/** Sentences done so far (cached before + by this job). */
export const jobDone = (job: AiCacheJob): number => job.cachedInitially + job.completedItems;

/** Overall progress 0..1 (OCR pages count during the OCR phase). */
export function jobProgress(job: AiCacheJob): number | undefined {
  if (job.phase === 'ocr') return job.ocrTotal > 0 ? job.ocrDone / job.ocrTotal : undefined;
  if (job.phase === 'explaining' || job.phase === 'done') return job.totalItems > 0 ? jobDone(job) / job.totalItems : 1;
  return undefined;
}

// ------------------------------------------------------------------ deps (test hooks)

export interface AiCacheDeps {
  /** Page image → payload for `ai.pageGuide` (raw manga). */
  loadPageImage(page: MangaPage): Promise<ImagePayload>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Parallel `ai.pageGuide` calls for raw volumes (memory-bounded on Android). */
  ocrConcurrency: number;
}

const defaultDeps: AiCacheDeps = {
  loadPageImage: (page) => downscalePageImage(page.imageUrl, page),
  sleep: abortableSleep,
  ocrConcurrency: 2,
};
let deps: AiCacheDeps = defaultDeps;

/** Override runner dependencies (tests). Pass `undefined` to restore defaults. */
export function setAiCacheDeps(override: Partial<AiCacheDeps> | undefined): void {
  deps = override ? { ...defaultDeps, ...override } : defaultDeps;
}

// ------------------------------------------------------------------ queue

const controllers = new Map<string, AbortController>();
const hosts = new Map<string, PlatformHost>();
let queue: string[] = [];
let running: string | undefined;
/** Bumped by `reset()` so a stale run never releases the queue of a newer generation. */
let generation = 0;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isCancelled = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'cancelled';

export const useAiCacheStore = create<AiCacheState>()((set, get) => {
  const patchJob = (key: string, patch: Partial<AiCacheJob>): void => {
    set((s) => {
      const job = s.jobs[key];
      return job ? { jobs: { ...s.jobs, [key]: { ...job, ...patch } } } : {};
    });
  };

  const tagsOf = (reqs: readonly ExplainRequest[]): string[] => {
    const model = useSettingsStore.getState().settings.ai.explainModel;
    return reqs.map((r) => cacheTag(r.sentence, r.targetLanguage, model));
  };

  const markCaching = (reqs: readonly ExplainRequest[]): void => {
    const tags = tagsOf(reqs);
    set((s) => ({ cachingTags: new Set([...s.cachingTags, ...tags]) }));
  };

  const settleTags = (reqs: readonly ExplainRequest[], ok: readonly ExplainRequest[]): void => {
    const all = new Set(tagsOf(reqs));
    const okTags = tagsOf(ok);
    set((s) => {
      const caching = new Set([...s.cachingTags].filter((t) => !all.has(t)));
      return okTags.length > 0 ? { cachingTags: caching, cachedTags: new Set([...s.cachedTags, ...okTags]) } : { cachingTags: caching };
    });
  };

  /** Explain phase shared by anime and manga jobs. */
  const explainAll = async (key: string, host: PlatformHost, requests: readonly ExplainRequest[], signal: AbortSignal): Promise<void> => {
    patchJob(key, { phase: 'explaining' });
    const result = await runExplainCache({
      ai: host.ai,
      requests,
      signal,
      sleep: deps.sleep,
      onChecked: ({ total, cached, cachedRequests }) => {
        patchJob(key, { totalItems: total, cachedInitially: cached, completedItems: 0, failedItems: 0 });
        if (cachedRequests.length > 0) settleTags([], cachedRequests);
      },
      onChunkStart: (reqs) => {
        if (!signal.aborted) markCaching(reqs);
      },
      onChunkSettled: (reqs, outcome: ChunkOutcome) => {
        settleTags(reqs, outcome.ok);
        const job = get().jobs[key];
        if (!job || signal.aborted) return;
        patchJob(key, { completedItems: job.completedItems + outcome.ok.length, failedItems: job.failedItems + outcome.failed.length });
      },
    });
    patchJob(key, { totalItems: result.total, cachedInitially: result.cachedInitially, completedItems: result.completed, failedItems: result.failed });
  };

  const runAnime = async (key: string, host: PlatformHost, target: Extract<AiCacheTarget, { kind: 'anime' }>, signal: AbortSignal): Promise<void> => {
    const settings = useSettingsStore.getState().settings;
    const episode = await host.anime.getEpisode(target.episodeId);
    const series = await host.anime.getSeries(episode.seriesId).catch(() => undefined);
    if (signal.aborted) return;
    const track = await resolveCacheTrack(host, episode, target.trackId, settings.anime.preferredSubtitleLanguages);
    if (signal.aborted) return;
    patchJob(key, { trackId: track.id });
    const parsed = await host.anime.getCues(track.id);
    if (signal.aborted) return;
    // Same row building as `Player.tsx` ⇒ same Japanese lines ⇒ same cache keys.
    const rows = buildTranscriptRows(parsed.cues, { mergeKaraoke: settings.anime.mergeKaraokeCues, hideSigns: settings.anime.hideSigns });
    const requests = collectSubtitleRequests({ rows, episodeId: episode.id, trackId: track.id, targetLanguage: settings.ai.targetLanguage, sceneHint: series?.title });
    await explainAll(key, host, requests, signal);
  };

  const runManga = async (key: string, host: PlatformHost, target: Extract<AiCacheTarget, { kind: 'manga' }>, signal: AbortSignal): Promise<void> => {
    const settings = useSettingsStore.getState().settings;
    const targetLanguage = settings.ai.targetLanguage;
    const [volume, pages] = await Promise.all([host.manga.getVolume(target.volumeId), host.manga.getPages(target.volumeId)]);
    if (signal.aborted) return;
    const sceneHint = volume.seriesTitle ?? volume.title;
    const requests: ExplainRequest[] = collectMangaBlockRequests({ volumeId: volume.id, pages: pages.filter((p) => p.blocks.length > 0), targetLanguage, sceneHint });

    // Raw (OCR-less) pages: ✨ page guide (cached by the host under the page-guide key)
    // finds the bubbles, which are then batch-explained like `.mokuro` blocks.
    const rawPages = pages.filter((p) => p.blocks.length === 0);
    if (rawPages.length > 0) {
      patchJob(key, { phase: 'ocr', ocrTotal: rawPages.length, ocrDone: 0 });
      const byPage = new Map<number, ExplainRequest[]>();
      let next = 0;
      let done = 0;
      let fatal: unknown;
      const worker = async (): Promise<void> => {
        while (fatal === undefined && !signal.aborted && next < rawPages.length) {
          const page = rawPages[next++]!;
          try {
            const image = await deps.loadPageImage(page);
            if (signal.aborted) return;
            const guide = await host.ai.pageGuide({ volumeId: volume.id, pageIndex: page.index, image, targetLanguage, knownBlocks: page.blocks }, { signal });
            byPage.set(page.index, collectGuideBubbleRequests({ volumeId: volume.id, page, guide, targetLanguage, sceneHint }));
          } catch (e) {
            if (signal.aborted) return;
            const code = (e as { code?: unknown } | null)?.code;
            if (code === 'ai-auth' || code === 'unsupported') {
              fatal ??= e;
              return;
            }
            // One unreadable page never aborts the volume.
          }
          done++;
          patchJob(key, { ocrDone: done });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.ocrConcurrency, rawPages.length)) }, worker));
      if (fatal !== undefined) throw fatal;
      if (signal.aborted) return;
      for (const page of rawPages) requests.push(...(byPage.get(page.index) ?? []));
    }
    await explainAll(key, host, requests, signal);
  };

  const runJob = async (key: string): Promise<void> => {
    const job = get().jobs[key];
    const host = hosts.get(key);
    const controller = controllers.get(key);
    if (!job || !host || !controller || controller.signal.aborted) return;
    const signal = controller.signal;
    const t = createTranslator(useSettingsStore.getState().settings.ui.locale);
    patchJob(key, { phase: 'checking', startedAt: Date.now() });
    try {
      if (!useSettingsStore.getState().settings.ai.cacheEnabled) throw new Error(t('aiCache.cacheDisabled'));
      if (job.target.kind === 'anime') await runAnime(key, host, job.target, signal);
      else await runManga(key, host, job.target, signal);
      if (signal.aborted) {
        patchJob(key, { phase: 'cancelled', finishedAt: Date.now() });
        return;
      }
      patchJob(key, { phase: 'done', finishedAt: Date.now() });
      const finished = get().jobs[key];
      if (finished) {
        showSnackbar(
          finished.failedItems > 0
            ? t('aiCache.doneWithFailures', { title: finished.title, done: jobDone(finished), total: finished.totalItems, failed: finished.failedItems })
            : t('aiCache.doneSnackbar', { title: finished.title, done: jobDone(finished), total: finished.totalItems }),
          finished.failedItems > 0 ? { tone: 'warning' } : undefined,
        );
      }
    } catch (e) {
      if (signal.aborted || isCancelled(e)) {
        patchJob(key, { phase: 'cancelled', finishedAt: Date.now() });
        return;
      }
      const message = errMsg(e) === 'no-japanese-subtitles' ? t('aiCache.noSubtitles') : errMsg(e);
      patchJob(key, { phase: 'error', errorMessage: message, finishedAt: Date.now() });
      showSnackbar(t('aiCache.failed', { title: get().jobs[key]?.title ?? '', message }), { tone: 'error' });
    } finally {
      controllers.delete(key);
      hosts.delete(key);
      // Nothing may stay `◌` once a job ends (cancel mid-chunk).
      set({ cachingTags: new Set() });
    }
  };

  const pump = (): void => {
    if (running !== undefined) return;
    const key = queue.shift();
    if (key === undefined) return;
    running = key;
    const gen = generation;
    void runJob(key).finally(() => {
      if (gen !== generation) return;
      running = undefined;
      pump();
    });
  };

  return {
    jobs: {},
    cachedTags: new Set(),
    cachingTags: new Set(),

    start(host, target) {
      const key = aiCacheKey(target);
      if (isActivePhase(get().jobs[key]?.phase)) return;
      const title = target.title ?? (target.kind === 'anime' ? target.episodeId : target.volumeId);
      const job: AiCacheJob = {
        key,
        target,
        title,
        phase: 'queued',
        totalItems: 0,
        cachedInitially: 0,
        completedItems: 0,
        failedItems: 0,
        ocrTotal: 0,
        ocrDone: 0,
        startedAt: Date.now(),
      };
      controllers.set(key, new AbortController());
      hosts.set(key, host);
      set((s) => ({ jobs: { ...s.jobs, [key]: job } }));
      queue.push(key);
      pump();
    },

    cancel(key) {
      const job = get().jobs[key];
      if (!job || !isActivePhase(job.phase)) return;
      controllers.get(key)?.abort();
      if (queue.includes(key)) {
        queue = queue.filter((k) => k !== key);
        controllers.delete(key);
        hosts.delete(key);
        patchJob(key, { phase: 'cancelled', finishedAt: Date.now() });
      }
    },

    toggle(host, target) {
      const key = aiCacheKey(target);
      if (isActivePhase(get().jobs[key]?.phase)) get().cancel(key);
      else get().start(host, target);
    },

    dismiss(key) {
      const job = get().jobs[key];
      if (!job || isActivePhase(job.phase)) return;
      set((s) => {
        const { [key]: _removed, ...rest } = s.jobs;
        return { jobs: rest };
      });
    },

    reset() {
      for (const c of controllers.values()) c.abort();
      controllers.clear();
      hosts.clear();
      queue = [];
      running = undefined;
      generation++;
      set({ jobs: {}, cachedTags: new Set(), cachingTags: new Set() });
    },
  };
});

/** The job for a target (or `undefined`). */
export function useAiCacheJob(key: string | undefined): AiCacheJob | undefined {
  return useAiCacheStore((s) => (key ? s.jobs[key] : undefined));
}
