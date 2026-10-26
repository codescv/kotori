/**
 * Server-side `AnimeApi`: library import/rescan (folder scanner → SQLite),
 * subtitle tracks (sidecar / imported / embedded / Jimaku), cue parsing with
 * an LRU(32) cache keyed by `(trackId, mtime)`, progress, Jimaku auto-fetch.
 */
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
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
import { createJimakuClient, detectSubtitleFormat, detectSubtitleLanguageFromName, matchJimakuFilesToEpisodes, parseSubtitle } from '@kotori/core';
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
}

const EXT_BY_FORMAT: Readonly<Record<SubtitleFormat, string>> = { ass: '.ass', srt: '.srt', vtt: '.vtt' };

export function createAnimeService(deps: AnimeServiceDeps): NodeAnimeService {
  const { repos } = deps;
  const now = deps.now ?? Date.now;
  const cueCache = new LruCache<string, ParsedSubtitleTrack>(32);
  const probes = new Set<Promise<void>>();

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
  function sync(seriesId: Id, scan: ScannedSeries, titleOverride: string | undefined, addedAt: number): void {
    transaction(deps.db, () => {
      repos.series.upsert({
        id: seriesId,
        title: titleOverride ?? repos.series.get(seriesId)?.title ?? scan.title,
        sourcePath: scan.sourcePath,
        addedAt,
        ...(scan.coverPath ? { coverPath: scan.coverPath } : {}),
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

  /** Background ffprobe: durations, embedded text tracks, codec warnings. */
  function probeSeries(seriesId: Id): void {
    const paths = deps.ffmpeg();
    if (!paths) return;
    const job = (async () => {
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

  async function importOrRescan(path: string, titleOverride: string | undefined): Promise<AnimeSeries> {
    if (!isAbsolute(path)) throw new KotoriError('invalid-argument', 'Import path must be absolute');
    const abs = resolve(path);
    if (!existsSync(abs)) throw new KotoriError('not-found', `Path not found: ${abs}`);
    const scan = await scanAnimeFolder(abs);
    if (scan.episodes.length === 0) throw new KotoriError('invalid-argument', `No video files (.mkv/.mp4/.webm) found in ${abs}`);
    const seriesId = stableId('sr', abs);
    const existing = repos.series.get(seriesId);
    sync(seriesId, scan, titleOverride, existing?.addedAt ?? now());
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
    importSeries: (request) => importOrRescan(request.path, request.titleOverride),
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
      const apiKey = deps.settings.get().anime.jimakuApiKey;
      const client = createJimakuClient({ fetch: deps.fetch, apiKey });
      let entryId = options?.entryId ?? series.jimakuEntryId;
      let entry: JimakuEntry | undefined;
      if (entryId === undefined) {
        const results = await client.searchEntries({ query: series.title, ...(series.anilistId !== undefined ? { anilistId: series.anilistId } : {}) });
        entry = results[0];
        if (!entry) throw new KotoriError('not-found', `No Jimaku entry found for "${series.title}"`);
        entryId = entry.id;
      }
      repos.series.setJimaku(seriesId, entryId, entry?.anilistId);
      const files = await client.listFiles(entryId);
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
