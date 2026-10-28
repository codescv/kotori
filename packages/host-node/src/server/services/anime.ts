/**
 * Server-side `AnimeApi`: library import/rescan (folder scanner → SQLite),
 * subtitle tracks (sidecar / imported / embedded / Jimaku), cue parsing with
 * an LRU(32) cache keyed by `(trackId, mtime)`, progress, Jimaku auto-fetch.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { KotoriError } from '@kotori/core';
import type {
  AnimeApi,
  AnimeEpisode,
  AnimeSeries,
  DownloadTask,
  HostEvent,
  Id,
  JimakuEntry,
  ParsedSubtitleTrack,
  SubtitleFormat,
  SubtitleTrack,
} from '@kotori/core';
import { createSubtitleSearchClient, detectSubtitleFormat, detectSubtitleLanguageFromName, matchJimakuFilesToEpisodes, parseSubtitle } from '@kotori/core';
import type { Repositories } from '../../db/repositories';
import { transaction, type Database } from '../../db/sqlite';
import { scanAnimeFolder, type ScannedSeries } from '../../library/anime-scanner';
import type { SubtitleStore } from '../../library/subtitle-store';
import { extractSubtitleStream, probeStreams, type FfmpegPaths } from '../../media/ffmpeg';
import type { SettingsStore } from '../../settings/store';
import type { DownloadManager } from '../../downloads/manager';
import { LruCache, stableId } from '../util';

export interface AnimeServiceDeps {
  readonly db: Database;
  readonly repos: Repositories;
  readonly settings: SettingsStore;
  readonly subtitles: SubtitleStore;
  readonly emit: (event: HostEvent) => void;
  readonly ffmpeg: () => FfmpegPaths | undefined;
  readonly downloads: () => DownloadManager;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}

export interface NodeAnimeService extends AnimeApi {
  /** Resolve the media file for `/media/:episodeId`. */
  mediaPath(episodeId: Id): string;
  /** Cover image path for a series (if any). */
  coverPath(seriesId: Id): string | undefined;
  /** Wait for background probes (tests / shutdown). */
  idle(): Promise<void>;
  /** Remove `path` (and any descendants) from the persistent excluded-anime-paths set. */
  unexcludePath(path: string): void;
  /** Scan configured anime library roots (plus ~/download/anime & ~/Downloads/anime) for unimported series. */
  scanRoots(roots?: readonly string[]): Promise<void>;
  autoFetchJimaku(
    seriesId: Id,
    options?: { readonly entryId?: number; readonly aliases?: readonly string[]; readonly anilistId?: number },
  ): Promise<readonly DownloadTask[]>;
}

const EXT_BY_FORMAT: Readonly<Record<SubtitleFormat, string>> = { ass: '.ass', srt: '.srt', vtt: '.vtt' };
const EXCLUDED_PATHS_KEY = 'excluded_anime_paths';

/** Expand leading `~` / `~/` and resolve to a normalized absolute path. */
export function resolveAnimePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return resolve(homedir());
  if (trimmed.startsWith('~/')) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

export function createAnimeService(deps: AnimeServiceDeps): NodeAnimeService {
  const { repos } = deps;
  const now = deps.now ?? Date.now;
  const cueCache = new LruCache<string, ParsedSubtitleTrack>(32);
  const probes = new Set<Promise<void>>();
  const subtitleClient = createSubtitleSearchClient({
    fetch: deps.fetch,
    jimakuApiKey: () => deps.settings.get().anime.jimakuApiKey,
  });

  function requireSeries(id: Id): AnimeSeries {
    const s = repos.series.get(id);
    if (!s) throw new KotoriError('not-found', `Series ${id} not found`);
    return s;
  }

  function requireEpisode(id: Id): AnimeEpisode {
    const e = repos.episodes.get(id);
    if (!e) throw new KotoriError('not-found', `Episode ${id} not found`);
    return e;
  }

  function requireTrack(id: Id): SubtitleTrack {
    const t = repos.tracks.get(id);
    if (!t) throw new KotoriError('not-found', `Subtitle track ${id} not found`);
    return t;
  }

  function getExcludedPaths(): Set<string> {
    const row = deps.db.prepare('SELECT json FROM settings WHERE key = ?').get(EXCLUDED_PATHS_KEY) as { json: string } | undefined;
    if (!row) return new Set();
    try {
      const parsed = JSON.parse(row.json) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((x): x is string => typeof x === 'string' && x.length > 0).map(resolveAnimePath));
    } catch {
      return new Set();
    }
  }

  function saveExcludedPaths(paths: ReadonlySet<string>): void {
    deps.db
      .prepare('INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json')
      .run(EXCLUDED_PATHS_KEY, JSON.stringify([...paths]));
  }

  function excludePath(p: string): void {
    const abs = resolveAnimePath(p);
    const next = getExcludedPaths();
    if (!next.has(abs)) {
      next.add(abs);
      saveExcludedPaths(next);
    }
  }

  function unexcludePath(p: string): void {
    const abs = resolveAnimePath(p);
    const prefix = abs === '/' ? '/' : `${abs}/`;
    const cur = getExcludedPaths();
    let changed = false;
    for (const x of [...cur]) {
      if (x === abs || x.startsWith(prefix)) {
        cur.delete(x);
        changed = true;
      }
    }
    if (changed) saveExcludedPaths(cur);
  }

  function isExcludedPath(p: string): boolean {
    const abs = resolveAnimePath(p);
    const excluded = getExcludedPaths();
    if (excluded.has(abs)) return true;
    for (const ex of excluded) {
      const prefix = ex === '/' ? '/' : `${ex}/`;
      if (abs.startsWith(prefix)) return true;
    }
    return false;
  }

  async function purgeSeriesRecord(series: AnimeSeries): Promise<void> {
    const episodes = repos.episodes.listBySeries(series.id);
    repos.series.remove(series.id);
    for (const ep of episodes) {
      cueCache.deleteWhere((k) => ep.subtitleTracks.some((t) => k.startsWith(`${t.id}|`)));
      await deps.subtitles.removeEpisode(ep.id);
    }
  }

  /** Persist a scan result; prunes vanished episodes and sidecars. */
  function sync(
    seriesId: Id,
    scan: ScannedSeries,
    titleOverride: string | undefined,
    addedAt: number,
    coverPathOverride?: string,
  ): void {
    const resolvedCover = scan.coverPath ?? coverPathOverride;
    transaction(deps.db, () => {
      repos.series.upsert({
        id: seriesId,
        title: titleOverride ?? repos.series.get(seriesId)?.title ?? scan.title,
        sourcePath: scan.sourcePath,
        addedAt,
        ...(resolvedCover ? { coverPath: resolvedCover } : {}),
      });
      const keep = new Set<Id>();
      scan.episodes.forEach((ep, sortIndex) => {
        const episodeId = stableId('ep', ep.filePath);
        keep.add(episodeId);
        repos.episodes.upsert({
          id: episodeId,
          seriesId,
          title: ep.title,
          fileName: ep.fileName,
          filePath: ep.filePath,
          container: ep.container,
          sizeBytes: ep.sizeBytes,
          parsedName: ep.parsedName,
          sortIndex,
        });
        const sidecarIds = new Set<Id>();
        for (const sc of ep.sidecars) {
          const trackId = stableId('tr', episodeId, sc.filePath);
          sidecarIds.add(trackId);
          repos.tracks.upsert({ id: trackId, episodeId, origin: 'external', format: sc.format, label: sc.label, filePath: sc.filePath, ...(sc.language ? { language: sc.language } : {}) }, now());
        }
        repos.tracks.pruneOrigin(episodeId, 'external', sidecarIds);
        ensureDefaultTrack(episodeId);
        if (ep.filePath !== scan.sourcePath) {
          const split = repos.series.getByPath(ep.filePath);
          if (split && split.id !== seriesId) repos.series.remove(split.id);
        }
      });
      for (const id of repos.episodes.idsBySeries(seriesId)) if (!keep.has(id)) repos.episodes.remove(id);
    });
  }

  /** Pick a default track (preferred languages first) when none is set. */
  function ensureDefaultTrack(episodeId: Id): void {
    if (repos.tracks.hasDefault(episodeId)) return;
    const tracks = repos.tracks.listByEpisode(episodeId).filter((t) => t.filePath || t.origin === 'embedded');
    if (tracks.length === 0) return;
    const prefs = deps.settings.get().anime.preferredSubtitleLanguages;
    const ranked = [...tracks].sort((a, b) => rank(a) - rank(b));
    function rank(t: SubtitleTrack): number {
      const i = t.language ? prefs.indexOf(t.language) : -1;
      return (i < 0 ? 100 : i) + (t.origin === 'embedded' && !t.filePath ? 50 : 0);
    }
    const best = ranked[0];
    if (best) repos.tracks.setDefault(episodeId, best.id);
  }

  /** Background AniList cover & metadata enrichment (saves poster.jpg like Fushi when possible). */
  async function enrichSeriesCover(seriesId: Id): Promise<void> {
    if (process.env['VITEST']) return;
    const series = repos.series.get(seriesId);
    if (!series) return;
    const currentCoverPath = repos.series.coverPath(seriesId);
    if (currentCoverPath && !/^https?:\/\//i.test(currentCoverPath) && existsSync(currentCoverPath)) return;

    let remoteCoverUrl = currentCoverPath && /^https?:\/\//i.test(currentCoverPath) ? currentCoverPath : undefined;
    const resolvedAnilistId = series.anilistId;
    if (resolvedAnilistId === undefined && !remoteCoverUrl) return;

    if (!remoteCoverUrl && resolvedAnilistId !== undefined) {
      try {
        const query = `query ($id: Int) { Media(id: $id, type: ANIME) { id coverImage { extraLarge large } } }`;
        const res = await deps.fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables: { id: resolvedAnilistId } }),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            data?: { Media?: { id?: number; coverImage?: { extraLarge?: string; large?: string } } };
          };
          const media = json.data?.Media;
          remoteCoverUrl = media?.coverImage?.extraLarge ?? media?.coverImage?.large;
        }
      } catch {
        // Best-effort metadata enrichment
      }
    }

    if (!remoteCoverUrl && resolvedAnilistId === undefined) return;

    let finalCoverPath = remoteCoverUrl;
    if (remoteCoverUrl) {
      try {
        const st = await stat(series.sourcePath).catch(() => undefined);
        if (!repos.series.get(seriesId) || isExcludedPath(series.sourcePath)) return;
        if (st?.isDirectory()) {
          const posterPath = join(series.sourcePath, 'poster.jpg');
          if (!existsSync(posterPath)) {
            const imgRes = await deps.fetch(remoteCoverUrl);
            if (!repos.series.get(seriesId) || isExcludedPath(series.sourcePath)) return;
            if (imgRes.ok) {
              const bytes = new Uint8Array(await imgRes.arrayBuffer());
              if (!repos.series.get(seriesId) || isExcludedPath(series.sourcePath)) return;
              if (bytes.byteLength > 256) {
                await writeFile(posterPath, bytes);
                finalCoverPath = posterPath;
              }
            }
          } else {
            finalCoverPath = posterPath;
          }
        }
      } catch {
        // Keep remoteCoverUrl if saving poster.jpg fails
      }
    }

    if (!repos.series.get(seriesId) || isExcludedPath(series.sourcePath)) return;
    repos.series.setMetadata(seriesId, {
      ...(finalCoverPath ? { coverPath: finalCoverPath } : {}),
      ...(resolvedAnilistId !== undefined ? { anilistId: resolvedAnilistId } : {}),
    });
    deps.emit({ type: 'library-changed', scope: 'anime' });
  }

  /** Background ffprobe: durations, embedded text tracks, codec warnings + AniList cover enrichment. */
  function probeSeries(seriesId: Id): void {
    const paths = deps.ffmpeg();
    const job = (async () => {
      await enrichSeriesCover(seriesId);
      if (!paths || !repos.series.get(seriesId)) return;
      const warned = new Set<string>();
      for (const ep of repos.episodes.listBySeries(seriesId)) {
        if (!repos.series.get(seriesId)) return;
        try {
          const probe = await probeStreams(paths, ep.filePath);
          if (!repos.series.get(seriesId) || !repos.episodes.get(ep.id)) return;
          for (const s of probe.subtitles) {
            const id = stableId('tr', ep.id, 'embedded', s.index);
            const existing = repos.tracks.get(id);
            repos.tracks.upsert(
              {
                id,
                episodeId: ep.id,
                origin: 'embedded',
                format: s.format,
                label: `${s.title ?? (s.language ? s.language.toUpperCase() : 'Embedded')} #${s.index} (${s.codec})`,
                streamIndex: s.index,
                ...(s.language ? { language: s.language } : {}),
                ...(existing?.filePath ? { filePath: existing.filePath } : {}),
              },
              now(),
            );
          }
          if (probe.durationMs !== undefined) {
            deps.db.prepare('UPDATE anime_episodes SET duration_ms = ? WHERE id = ?').run(probe.durationMs, ep.id);
          }
          ensureDefaultTrack(ep.id);
          for (const w of probe.warnings) {
            if (warned.has(w)) continue;
            warned.add(w);
            deps.emit({ type: 'host-notice', level: 'warning', message: `${ep.fileName}: ${w}` });
          }
        } catch (error) {
          console.warn(`[kotori:anime] ffprobe failed for ${ep.fileName}:`, error instanceof Error ? error.message : error);
        }
      }
      if (!repos.series.get(seriesId)) return;
      deps.emit({ type: 'library-changed', scope: 'anime' });
    })();
    probes.add(job);
    void job.finally(() => probes.delete(job));
  }

  async function importOrRescan(
    path: string,
    titleOverride: string | undefined,
    anilistId?: number,
    coverUrl?: string,
    options?: { readonly expectedSeriesId?: Id },
  ): Promise<AnimeSeries> {
    if (!isAbsolute(path)) throw new KotoriError('invalid-argument', 'Import path must be absolute');
    const abs = resolve(path);
    if (!existsSync(abs)) throw new KotoriError('not-found', `Path not found: ${abs}`);
    if (isExcludedPath(abs)) throw new KotoriError('not-found', `Series at ${abs} was excluded`);
    const scan = await scanAnimeFolder(abs);
    if (scan.episodes.length === 0) throw new KotoriError('invalid-argument', `No video files (.mkv/.mp4/.webm) found in ${abs}`);
    if (isExcludedPath(abs)) throw new KotoriError('not-found', `Series at ${abs} was removed during scan`);
    if (options?.expectedSeriesId !== undefined && !repos.series.get(options.expectedSeriesId)) {
      throw new KotoriError('not-found', `Series ${options.expectedSeriesId} not found`);
    }
    const seriesId = stableId('sr', abs);
    const existing = repos.series.get(seriesId);
    sync(seriesId, scan, titleOverride, existing?.addedAt ?? now(), coverUrl);
    if (anilistId !== undefined) {
      repos.series.setJimaku(seriesId, existing?.jimakuEntryId, anilistId);
    }
    probeSeries(seriesId);
    deps.emit({ type: 'library-changed', scope: 'anime' });
    return requireSeries(seriesId);
  }

  async function trackFile(track: SubtitleTrack): Promise<string> {
    if (track.filePath) return track.filePath;
    if (track.origin === 'embedded' && track.streamIndex !== undefined) {
      const extracted = await extract(track.episodeId, track.streamIndex);
      if (extracted.filePath) return extracted.filePath;
    }
    throw new KotoriError('not-found', `Track ${track.id} has no subtitle file`);
  }

  async function extract(episodeId: Id, streamIndex: number): Promise<SubtitleTrack> {
    const paths = deps.ffmpeg();
    if (!paths) throw new KotoriError('unsupported', 'ffmpeg is not installed; embedded subtitle extraction is unavailable');
    const ep = requireEpisode(episodeId);
    const id = stableId('tr', episodeId, 'embedded', streamIndex);
    const known = repos.tracks.get(id);
    const format: SubtitleFormat = known?.format ?? 'ass';
    const out = await deps.subtitles.allocate(episodeId, `stream${streamIndex}${EXT_BY_FORMAT[format]}`);
    await extractSubtitleStream(paths, ep.filePath, streamIndex, out);
    const track = repos.tracks.upsert(
      {
        id,
        episodeId,
        origin: 'embedded',
        format,
        label: known?.label ?? `Embedded #${streamIndex}`,
        filePath: out,
        streamIndex,
        ...(known?.language ? { language: known.language } : {}),
      },
      now(),
    );
    cueCache.deleteWhere((k) => k.startsWith(`${id}|`));
    ensureDefaultTrack(episodeId);
    return repos.tracks.get(track.id) ?? track;
  }

  function sidecarsChanged(
    scanned: readonly { readonly filePath: string }[],
    currentTracks: readonly SubtitleTrack[],
  ): boolean {
    const scannedPaths = scanned.map((s) => s.filePath).sort();
    const currentPaths = currentTracks
      .filter((t) => t.origin === 'external' && t.filePath !== undefined)
      .map((t) => t.filePath!)
      .sort();
    if (scannedPaths.length !== currentPaths.length) return true;
    for (let i = 0; i < scannedPaths.length; i++) {
      if (scannedPaths[i] !== currentPaths[i]) return true;
    }
    return false;
  }

  /** Reconcile existing series against disk when files are added or deleted. */
  async function syncExistingSeries(targetSeriesId?: Id): Promise<void> {
    const targets =
      targetSeriesId !== undefined
        ? [repos.series.get(targetSeriesId)].filter((s): s is AnimeSeries => s !== undefined)
        : repos.series.list();
    for (const series of targets) {
      if (!repos.series.get(series.id) || isExcludedPath(series.sourcePath)) continue;
      if (!existsSync(series.sourcePath)) continue;
      const scan = await scanAnimeFolder(series.sourcePath).catch(() => undefined);
      if (!scan) continue;
      const current = repos.series.get(series.id);
      if (!current || isExcludedPath(current.sourcePath)) continue;
      const currentEps = repos.episodes.listBySeries(current.id);
      const changed =
        scan.episodes.length !== currentEps.length ||
        scan.episodes.some((ep, i) => {
          const cur = currentEps[i];
          if (!cur) return true;
          return (
            ep.filePath !== cur.filePath ||
            ep.sizeBytes !== cur.sizeBytes ||
            sidecarsChanged(ep.sidecars, cur.subtitleTracks)
          );
        });
      if (!changed) continue;
      if (!repos.series.get(current.id) || isExcludedPath(current.sourcePath)) continue;
      if (scan.episodes.length === 0) {
        for (const id of repos.episodes.idsBySeries(current.id)) {
          repos.episodes.remove(id);
        }
        deps.emit({ type: 'library-changed', scope: 'anime' });
      } else {
        sync(current.id, scan, current.title, current.addedAt, repos.series.coverPath(current.id));
        probeSeries(current.id);
        deps.emit({ type: 'library-changed', scope: 'anime' });
      }
    }
  }

  let scanChain: Promise<void> = Promise.resolve();
  function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = scanChain.then(fn, fn);
    scanChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function scanRootsInternal(roots?: readonly string[]): Promise<void> {
    const configured = roots ?? deps.settings.get().library.animeRoots;
    const configuredSet = new Set(configured.filter(Boolean).map(resolveAnimePath));
    const defaultDirs = process.env['VITEST'] ? [] : [deps.settings.get().downloads.downloadDir];
    const seenRoots = new Set<string>();
    const allRoots = [...configured, ...defaultDirs].filter((p) => {
      if (!p) return false;
      const abs = resolveAnimePath(p);
      if (seenRoots.has(abs)) return false;
      seenRoots.add(abs);
      return true;
    });
    const incompletePaths = new Set<string>();
    try {
      for (const task of deps.downloads().list()) {
        if (task.status !== 'completed') {
          for (const f of task.files ?? []) {
            const firstSeg = f.path.split('/')[0];
            if (firstSeg) incompletePaths.add(resolve(join(task.targetDir, firstSeg)));
            incompletePaths.add(resolve(join(task.targetDir, ...f.path.split('/'))));
          }
          if (task.title) {
            incompletePaths.add(resolve(join(task.targetDir, task.title)));
          }
        }
      }
    } catch {
      // DownloadManager may not be initialized yet
    }
    for (const rawRoot of allRoots) {
      const rootPath = resolveAnimePath(rawRoot);
      if (!existsSync(rootPath) || isExcludedPath(rootPath) || incompletePaths.has(rootPath)) continue;
      const isConfiguredRoot = configured.includes(rawRoot) || configuredSet.has(rootPath);
      try {
        const rootStat = await stat(rootPath);
        if (isExcludedPath(rootPath)) continue;
        if (rootStat.isFile()) {
          if (isConfiguredRoot && !isExcludedPath(rootPath) && !repos.series.getByPath(rootPath) && !repos.episodes.get(stableId('ep', rootPath))) {
            await importOrRescan(rootPath, undefined).catch(() => undefined);
          }
          continue;
        }
        const entries = await readdir(rootPath, { withFileTypes: true });
        if (isExcludedPath(rootPath)) continue;
        const childDirs: string[] = [];
        const videoFiles: string[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
          const childPath = resolve(join(rootPath, entry.name));
          if (incompletePaths.has(childPath)) continue;
          if (entry.isDirectory()) {
            childDirs.push(childPath);
          } else if (entry.isFile() && /\.(mkv|mp4|webm|m4v)$/i.test(entry.name)) {
            videoFiles.push(childPath);
          }
        }

        if (isConfiguredRoot && childDirs.length === 0 && videoFiles.length > 0) {
          let removedSplit = false;
          const savedProgress = new Map<Id, NonNullable<AnimeEpisode['progress']>>();
          for (const vf of videoFiles) {
            const split = repos.series.getByPath(vf);
            if (split && split.id !== stableId('sr', rootPath)) {
              for (const ep of repos.episodes.listBySeries(split.id)) {
                if (ep.progress) savedProgress.set(ep.id, ep.progress);
              }
              await purgeSeriesRecord(split);
              removedSplit = true;
            }
          }
          if (!repos.series.getByPath(rootPath) && !isExcludedPath(rootPath)) {
            const imported = await importOrRescan(rootPath, undefined).catch(() => undefined);
            if (imported && savedProgress.size > 0 && repos.series.get(imported.id) && !isExcludedPath(rootPath)) {
              for (const [epId, prog] of savedProgress) {
                if (repos.episodes.get(epId)) repos.episodes.saveProgress(epId, prog);
              }
            }
          } else if (removedSplit) {
            deps.emit({ type: 'library-changed', scope: 'anime' });
          }
        } else {
          let hasChildSeries = false;
          for (const dirPath of childDirs) {
            if (isExcludedPath(dirPath)) {
              hasChildSeries = true;
              continue;
            }
            if (!repos.series.getByPath(dirPath)) {
              const s = await importOrRescan(dirPath, undefined).catch(() => undefined);
              if (s || isExcludedPath(dirPath)) hasChildSeries = true;
            } else {
              hasChildSeries = true;
            }
          }
          if (isConfiguredRoot && !hasChildSeries && videoFiles.length > 0) {
            let removedSplit = false;
            const savedProgress = new Map<Id, NonNullable<AnimeEpisode['progress']>>();
            for (const vf of videoFiles) {
              const split = repos.series.getByPath(vf);
              if (split && split.id !== stableId('sr', rootPath)) {
                for (const ep of repos.episodes.listBySeries(split.id)) {
                  if (ep.progress) savedProgress.set(ep.id, ep.progress);
                }
                await purgeSeriesRecord(split);
                removedSplit = true;
              }
            }
            if (!repos.series.getByPath(rootPath) && !isExcludedPath(rootPath)) {
              const imported = await importOrRescan(rootPath, undefined).catch(() => undefined);
              if (imported && savedProgress.size > 0 && repos.series.get(imported.id) && !isExcludedPath(rootPath)) {
                for (const [epId, prog] of savedProgress) {
                  if (repos.episodes.get(epId)) repos.episodes.saveProgress(epId, prog);
                }
              }
            } else if (removedSplit) {
              deps.emit({ type: 'library-changed', scope: 'anime' });
            }
          } else if ((!isConfiguredRoot || childDirs.length > 0) && !repos.series.getByPath(rootPath) && !isExcludedPath(rootPath)) {
            for (const filePath of videoFiles) {
              if (!isExcludedPath(filePath) && !repos.series.getByPath(filePath) && !repos.episodes.get(stableId('ep', filePath))) {
                await importOrRescan(filePath, undefined).catch(() => undefined);
              }
            }
          }
        }
      } catch {
        // Ignore unreadable directories
      }
    }
    await syncExistingSeries().catch(() => undefined);
  }

  const service: NodeAnimeService = {
    unexcludePath,
    async listSeries() {
      if (!process.env['VITEST'] || deps.settings.get().library.animeRoots.length > 0) {
        await service.scanRoots().catch(() => undefined);
      } else {
        await runSerialized(() => syncExistingSeries()).catch(() => undefined);
      }
      return repos.series.list();
    },
    async getSeries(id) {
      requireSeries(id);
      await runSerialized(() => syncExistingSeries(id)).catch(() => undefined);
      return requireSeries(id);
    },
    async listEpisodes(seriesId) {
      requireSeries(seriesId);
      await runSerialized(() => syncExistingSeries(seriesId)).catch(() => undefined);
      return repos.episodes.listBySeries(seriesId);
    },
    async getEpisode(id) {
      return requireEpisode(id);
    },
    importSeries: async (request) => {
      if (!isAbsolute(request.path)) throw new KotoriError('invalid-argument', 'Import path must be absolute');
      unexcludePath(request.path);
      return importOrRescan(request.path, request.titleOverride, request.anilistId, request.coverUrl);
    },
    async updateSeries(seriesId, patch) {
      const series = requireSeries(seriesId);
      const oldCoverPath = repos.series.coverPath(seriesId);
      const autoPosterPath = join(series.sourcePath, 'poster.jpg');
      const nextTitle = patch.title !== undefined && patch.title.trim() !== '' ? patch.title.trim() : undefined;

      let coverPathPatch: string | null | undefined;
      if (patch.coverUrl === null || (typeof patch.coverUrl === 'string' && patch.coverUrl.trim() === '')) {
        if (oldCoverPath && resolve(oldCoverPath) === resolve(autoPosterPath)) {
          await rm(oldCoverPath, { force: true });
        }
        coverPathPatch = null;
      } else if (typeof patch.coverUrl === 'string') {
        const trimmedCover = patch.coverUrl.trim();
        if (trimmedCover !== series.coverUrl) {
          if (
            oldCoverPath &&
            resolve(oldCoverPath) === resolve(autoPosterPath) &&
            resolve(trimmedCover) !== resolve(autoPosterPath)
          ) {
            await rm(oldCoverPath, { force: true });
          }
          coverPathPatch = trimmedCover;
        }
      } else if (
        typeof patch.anilistId === 'number' &&
        patch.anilistId !== series.anilistId &&
        oldCoverPath &&
        resolve(oldCoverPath) === resolve(autoPosterPath)
      ) {
        await rm(oldCoverPath, { force: true });
        coverPathPatch = null;
      }

      const anilistPatch =
        patch.anilistId === null ? null : typeof patch.anilistId === 'number' ? patch.anilistId : undefined;

      repos.series.update(seriesId, {
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(coverPathPatch !== undefined ? { coverPath: coverPathPatch } : {}),
        ...(anilistPatch !== undefined ? { anilistId: anilistPatch } : {}),
      });

      if (typeof patch.anilistId === 'number' || (typeof patch.coverUrl === 'string' && patch.coverUrl.trim() !== '')) {
        const job = enrichSeriesCover(seriesId);
        probes.add(job);
        void job.finally(() => probes.delete(job));
      }

      deps.emit({ type: 'library-changed', scope: 'anime' });
      return requireSeries(seriesId);
    },
    async scanRoots(roots) {
      await runSerialized(() => scanRootsInternal(roots));
    },
    async removeSeries(seriesId, deleteFiles = false) {
      const series = requireSeries(seriesId);
      const seriesPath = resolveAnimePath(series.sourcePath);
      const episodes = repos.episodes.listBySeries(series.id);
      const isSingleFileSeries = episodes.length === 1 && resolveAnimePath(episodes[0]!.filePath) === seriesPath;

      excludePath(seriesPath);
      repos.series.remove(series.id);
      for (const ep of episodes) {
        cueCache.deleteWhere((k) => ep.subtitleTracks.some((t) => k.startsWith(`${t.id}|`)));
        await deps.subtitles.removeEpisode(ep.id);
        if (deleteFiles) {
          await rm(ep.filePath, { force: true });
          for (const t of ep.subtitleTracks) if (t.origin === 'external' && t.filePath) await rm(t.filePath, { force: true });
        }
      }

      const currentRoots = deps.settings.get().library.animeRoots;
      if (currentRoots.length > 0) {
        const remainingSeries = repos.series.list();
        const filteredRoots = currentRoots.filter((rawRoot) => {
          const rootAbs = resolveAnimePath(rawRoot);
          if (rootAbs === seriesPath) return false;
          if (isSingleFileSeries && dirname(seriesPath) === rootAbs) {
            const prefix = rootAbs === '/' ? '/' : `${rootAbs}/`;
            const hasOtherInRoot = remainingSeries.some((s) => {
              const sp = resolveAnimePath(s.sourcePath);
              return sp === rootAbs || sp.startsWith(prefix);
            });
            if (!hasOtherInRoot) return false;
          }
          return true;
        });
        if (filteredRoots.length !== currentRoots.length) {
          const nextSettings = deps.settings.update({ library: { animeRoots: filteredRoots } });
          deps.emit({ type: 'settings-changed', settings: nextSettings });
        }
      }

      deps.emit({ type: 'library-changed', scope: 'anime' });
    },
    async rescanSeries(seriesId) {
      const series = requireSeries(seriesId);
      return importOrRescan(series.sourcePath, undefined, undefined, undefined, { expectedSeriesId: seriesId });
    },
    async getCues(trackId) {
      const track = requireTrack(trackId);
      const file = await trackFile(track);
      let mtime: number;
      try {
        mtime = (await stat(file)).mtimeMs;
      } catch {
        throw new KotoriError('not-found', `Subtitle file missing: ${file}`);
      }
      const key = `${trackId}|${mtime}`;
      let parsed = cueCache.get(key);
      if (!parsed) {
        parsed = parseSubtitle({ bytes: new Uint8Array(await readFile(file)), fileName: basename(file) });
        cueCache.set(key, parsed);
        if (track.cueCount !== parsed.cues.length) repos.tracks.setCueCount(trackId, parsed.cues.length);
      }
      const delay = track.delayMs;
      if (delay === 0) return parsed;
      return { ...parsed, cues: parsed.cues.map((c) => ({ ...c, startMs: Math.max(0, c.startMs + delay), endMs: Math.max(0, c.endMs + delay) })) };
    },
    async addSubtitleTrack(episodeId, input) {
      requireEpisode(episodeId);
      if (!input.fileName) throw new KotoriError('invalid-argument', 'fileName is required');
      let stored: string;
      let text: string;
      if (input.content !== undefined) {
        text = input.content;
        stored = await deps.subtitles.writeText(episodeId, input.fileName, input.content);
      } else if (input.path) {
        if (!isAbsolute(input.path) || !existsSync(input.path)) throw new KotoriError('not-found', `Subtitle file not found: ${input.path}`);
        stored = await deps.subtitles.copyFrom(episodeId, input.path, input.fileName);
        text = '';
      } else {
        throw new KotoriError('invalid-argument', 'Either path or content is required');
      }
      const parsed = parseSubtitle(text ? { text, fileName: input.fileName } : { bytes: new Uint8Array(await readFile(stored)), fileName: input.fileName });
      const format = detectSubtitleFormat(text || '', input.fileName) ?? parsed.info.format;
      if (parsed.cues.length === 0) {
        await deps.subtitles.removeFile(stored);
        throw new KotoriError('parse', `No subtitle cues found in ${input.fileName}`);
      }
      const language = input.language ?? detectSubtitleLanguageFromName(input.fileName) ?? parsed.info.language;
      const id = stableId('tr', episodeId, stored);
      const track = repos.tracks.upsert(
        { id, episodeId, origin: 'imported', format, label: `${basename(input.fileName, extname(input.fileName))} (${format})`, filePath: stored, cueCount: parsed.cues.length, ...(language ? { language } : {}) },
        now(),
      );
      cueCache.deleteWhere((k) => k.startsWith(`${id}|`));
      ensureDefaultTrack(episodeId);
      deps.emit({ type: 'library-changed', scope: 'anime' });
      return repos.tracks.get(track.id) ?? track;
    },
    extractEmbeddedTrack: extract,
    async removeSubtitleTrack(trackId) {
      const track = requireTrack(trackId);
      repos.tracks.remove(trackId);
      cueCache.deleteWhere((k) => k.startsWith(`${trackId}|`));
      if (track.filePath) await deps.subtitles.removeFile(track.filePath);
      ensureDefaultTrack(track.episodeId);
    },
    async setTrackDelay(trackId, delayMs) {
      requireTrack(trackId);
      if (!Number.isFinite(delayMs)) throw new KotoriError('invalid-argument', 'delayMs must be a number');
      repos.tracks.setDelay(trackId, delayMs);
      return requireTrack(trackId);
    },
    async setDefaultTrack(episodeId, trackId) {
      const track = requireTrack(trackId);
      if (track.episodeId !== episodeId) throw new KotoriError('invalid-argument', 'Track does not belong to this episode');
      repos.tracks.setDefault(episodeId, trackId);
    },
    async saveProgress(episodeId, progress) {
      const ep = requireEpisode(episodeId);
      repos.episodes.saveProgress(episodeId, progress);
      repos.series.touchWatched(ep.seriesId, episodeId, progress.updatedAt || now());
    },
    async autoFetchJimaku(seriesId, options) {
      const series = requireSeries(seriesId);
      let entryId = options?.entryId ?? series.jimakuEntryId;
      const anilistId = options?.anilistId ?? series.anilistId;
      let entry: JimakuEntry | undefined;
      if (entryId === undefined) {
        const queryCandidates = [series.title, ...(options?.aliases ?? [])]
          .map((s) => s.trim())
          .filter((s, i, a) => s.length > 0 && a.indexOf(s) === i);
        const results = await subtitleClient.searchEntries({
          query: queryCandidates.join('|'),
          ...(anilistId !== undefined ? { anilistId } : {}),
        });
        entry = results[0];
        if (!entry) throw new KotoriError('not-found', `No Jimaku entry found for "${series.title}"`);
        entryId = entry.id;
      }
      repos.series.setJimaku(seriesId, entryId, entry?.anilistId ?? anilistId);
      const files = await subtitleClient.listFiles(entryId);
      const resolvedEntry: JimakuEntry = entry ?? { id: entryId, name: series.title, flags: { anime: true, unverified: false, external: false, movie: false, adult: false } };
      const episodes = repos.episodes.listBySeries(seriesId);
      const matches = matchJimakuFilesToEpisodes(files, episodes);
      const tasks: DownloadTask[] = [];
      const manager = deps.downloads();
      for (const ep of episodes) {
        const file = matches.get(ep.id);
        if (!file || ep.subtitleTracks.some((t) => t.origin === 'jimaku')) continue;
        tasks.push(await manager.start({ source: { kind: 'jimaku', entry: resolvedEntry, file, episodeId: ep.id, seriesId }, autoImport: true, title: `${series.title} · ${file.name}` }));
      }
      if (tasks.length === 0) {
        const pack = files.find((f) => f.archiveFormat === 'zip');
        if (pack) tasks.push(await manager.start({ source: { kind: 'jimaku', entry: resolvedEntry, file: pack, seriesId }, autoImport: true, title: `${series.title} · ${pack.name}` }));
      }
      return tasks;
    },
    mediaPath(episodeId) {
      return requireEpisode(episodeId).filePath;
    },
    coverPath(seriesId) {
      return repos.series.coverPath(seriesId);
    },
    async idle() {
      await Promise.all([...probes]);
    },
  };
  return service;
}

/** Attach a downloaded subtitle file to an episode (Jimaku auto-import hook). */
export async function attachJimakuSubtitle(deps: Pick<AnimeServiceDeps, 'repos' | 'subtitles' | 'now'>, episodeId: Id, filePath: string, fileName: string): Promise<SubtitleTrack> {
  const stored = await deps.subtitles.copyFrom(episodeId, filePath, fileName);
  const parsed = parseSubtitle({ bytes: new Uint8Array(await readFile(stored)), fileName });
  const language = detectSubtitleLanguageFromName(fileName) ?? 'ja';
  const id = stableId('tr', episodeId, stored);
  const track = deps.repos.tracks.upsert(
    { id, episodeId, origin: 'jimaku', format: parsed.info.format, label: `Jimaku · ${fileName}`, filePath: stored, cueCount: parsed.cues.length, language },
    (deps.now ?? Date.now)(),
  );
  if (!deps.repos.tracks.hasDefault(episodeId) || language === 'ja') {
    const current = deps.repos.tracks.listByEpisode(episodeId).find((t) => t.isDefault);
    if (!current || (current.language !== 'ja' && language === 'ja')) deps.repos.tracks.setDefault(episodeId, track.id);
  }
  return deps.repos.tracks.get(track.id) ?? track;
}
