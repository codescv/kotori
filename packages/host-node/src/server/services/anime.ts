/**
 * Server-side `AnimeApi`: library import/rescan (folder scanner → SQLite),
 * subtitle tracks (sidecar / imported / embedded / Jimaku), cue parsing with
 * an LRU(32) cache keyed by `(trackId, mtime)`, progress, Jimaku auto-fetch.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
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
  /** Scan configured anime library roots (plus ~/download/anime & ~/Downloads/anime) for unimported series. */
  scanRoots(roots?: readonly string[]): Promise<void>;
  autoFetchJimaku(
    seriesId: Id,
    options?: { readonly entryId?: number; readonly aliases?: readonly string[]; readonly anilistId?: number },
  ): Promise<readonly DownloadTask[]>;
}

const EXT_BY_FORMAT: Readonly<Record<SubtitleFormat, string>> = { ass: '.ass', srt: '.srt', vtt: '.vtt' };

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
    let resolvedAnilistId = series.anilistId;

    if (!remoteCoverUrl) {
      const cleanedTitle = series.title
        .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, ' ')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/\b(?:1080p|720p|2160p|4K|HEVC|x265|x264|10bit|BD|BDRip|WEB-?DL|WEBRip|FLAC|AAC|RAW|Batch|S\d+E?\d*)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanedTitle.length >= 2 || resolvedAnilistId !== undefined) {
        try {
          const query =
            resolvedAnilistId !== undefined
              ? `query ($id: Int) { Media(id: $id, type: ANIME) { id coverImage { extraLarge large } } }`
              : `query ($search: String) { Media(search: $search, type: ANIME, sort: [POPULARITY_DESC, SCORE_DESC], isAdult: false) { id coverImage { extraLarge large } } }`;
          const variables = resolvedAnilistId !== undefined ? { id: resolvedAnilistId } : { search: cleanedTitle };
          const res = await deps.fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ query, variables }),
          });
          if (res.ok) {
            const json = (await res.json()) as {
              data?: { Media?: { id?: number; coverImage?: { extraLarge?: string; large?: string } } };
            };
            const media = json.data?.Media;
            if (media?.id && resolvedAnilistId === undefined) resolvedAnilistId = media.id;
            remoteCoverUrl = media?.coverImage?.extraLarge ?? media?.coverImage?.large;
          }
        } catch {
          // Best-effort metadata enrichment
        }
      }
    }

    if (!remoteCoverUrl && resolvedAnilistId === undefined) return;

    let finalCoverPath = remoteCoverUrl;
    if (remoteCoverUrl) {
      try {
        const st = await stat(series.sourcePath).catch(() => undefined);
        if (st?.isDirectory()) {
          const posterPath = join(series.sourcePath, 'poster.jpg');
          if (!existsSync(posterPath)) {
            const imgRes = await deps.fetch(remoteCoverUrl);
            if (imgRes.ok) {
              const bytes = new Uint8Array(await imgRes.arrayBuffer());
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
      if (!paths) return;
      const warned = new Set<string>();
      for (const ep of repos.episodes.listBySeries(seriesId)) {
        try {
          const probe = await probeStreams(paths, ep.filePath);
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
  ): Promise<AnimeSeries> {
    if (!isAbsolute(path)) throw new KotoriError('invalid-argument', 'Import path must be absolute');
    const abs = resolve(path);
    if (!existsSync(abs)) throw new KotoriError('not-found', `Path not found: ${abs}`);
    const scan = await scanAnimeFolder(abs);
    if (scan.episodes.length === 0) throw new KotoriError('invalid-argument', `No video files (.mkv/.mp4/.webm) found in ${abs}`);
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

  const service: NodeAnimeService = {
    async listSeries() {
      if (!process.env['VITEST']) {
        await service.scanRoots().catch(() => undefined);
      }
      return repos.series.list();
    },
    async getSeries(id) {
      return requireSeries(id);
    },
    async listEpisodes(seriesId) {
      requireSeries(seriesId);
      return repos.episodes.listBySeries(seriesId);
    },
    async getEpisode(id) {
      return requireEpisode(id);
    },
    importSeries: (request) => importOrRescan(request.path, request.titleOverride, request.anilistId, request.coverUrl),
    async scanRoots(roots) {
      const configured = roots ?? deps.settings.get().library.animeRoots;
      const defaultDirs = process.env['VITEST']
        ? []
        : [
            join(deps.settings.get().downloads.downloadDir, 'anime'),
            deps.settings.get().downloads.downloadDir,
            join(homedir(), 'download', 'anime'),
            join(homedir(), 'Downloads', 'anime'),
          ];
      const allRoots = [...configured, ...defaultDirs].filter((p, i, a) => Boolean(p) && a.indexOf(p) === i);
      for (const rawRoot of allRoots) {
        const rootPath = rawRoot.startsWith('~/') ? join(homedir(), rawRoot.slice(2)) : resolve(rawRoot);
        if (!existsSync(rootPath)) continue;
        try {
          const entries = await readdir(rootPath, { withFileTypes: true });
          let importedChild = false;
          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
            const childPath = join(rootPath, entry.name);
            if (entry.isDirectory()) {
              if (!repos.series.getByPath(childPath)) {
                const s = await importOrRescan(childPath, undefined).catch(() => undefined);
                if (s) importedChild = true;
              } else {
                importedChild = true;
              }
            } else if (entry.isFile() && /\.(mkv|mp4|webm|m4v)$/i.test(entry.name)) {
              if (!repos.series.getByPath(childPath) && !repos.episodes.get(stableId('ep', childPath))) {
                const s = await importOrRescan(childPath, undefined).catch(() => undefined);
                if (s) importedChild = true;
              }
            }
          }
          if (!importedChild && configured.includes(rawRoot) && !repos.series.getByPath(rootPath)) {
            await importOrRescan(rootPath, undefined).catch(() => undefined);
          }
        } catch {
          // Ignore unreadable directories
        }
      }
    },
    async removeSeries(seriesId, deleteFiles = false) {
      const series = requireSeries(seriesId);
      const episodes = repos.episodes.listBySeries(series.id);
      repos.series.remove(series.id);
      for (const ep of episodes) {
        cueCache.deleteWhere((k) => ep.subtitleTracks.some((t) => k.startsWith(`${t.id}|`)));
        await deps.subtitles.removeEpisode(ep.id);
        if (deleteFiles) {
          await rm(ep.filePath, { force: true });
          for (const t of ep.subtitleTracks) if (t.origin === 'external' && t.filePath) await rm(t.filePath, { force: true });
        }
      }
      deps.emit({ type: 'library-changed', scope: 'anime' });
    },
    async rescanSeries(seriesId) {
      const series = requireSeries(seriesId);
      return importOrRescan(series.sourcePath, undefined);
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
