/**
 * Anime library over the Capacitor filesystem + IndexedDB.
 *
 * Import scans a picked directory (or a single video file): video files
 * become episodes (`parseEpisodeName`), sidecar subtitles are attached by
 * basename prefix (falling back to a unique episode-number match), the
 * default track prefers `anime.preferredSubtitleLanguages` (default `ja`).
 * `mediaUrl = convertFileSrc(filePath)`. Parsed cues are cached in an LRU
 * (32 tracks) keyed by `(trackId, mtime, size)`; `delayMs` is applied on read.
 */
import type {
  AnimeApi,
  AnimeEpisode,
  AnimeSeries,
  DownloadRequest,
  DownloadTask,
  JimakuEntry,
  LanguageTag,
  ParsedSubtitleTrack,
  PlaybackProgress,
  SubtitleFormat,
  SubtitleTrack,
  SubtitleTrackOrigin,
  VideoContainer,
} from '@kotori/core';
import {
  KotoriError,
  applyDelay,
  compareNatural,
  createSubtitleSearchClient,
  detectSubtitleLanguageFromName,
  matchJimakuFilesToEpisodes,
  parseEpisodeName,
  parseSubtitle,
} from '../adapters/core';
import { KeyedDebouncer, stableId, uniqueId, type HostContext } from '../context';
import type { FsEntry } from '../deps';
import { basename, dirname, extname, isWithin, joinPath, safeFileName, stem } from '../paths';
import type { StoredEpisode, StoredSeries, StoredTrack } from '../storage/idb';

const VIDEO_EXT: Readonly<Record<string, VideoContainer>> = {
  mp4: 'mp4',
  m4v: 'mp4',
  mov: 'mp4',
  mkv: 'mkv',
  webm: 'webm',
  avi: 'other',
  ts: 'other',
};
const SUBTITLE_EXT: Readonly<Record<string, SubtitleFormat>> = { srt: 'srt', vtt: 'vtt', ass: 'ass', ssa: 'ass' };
const CUE_CACHE_SIZE = 32;

export interface AddTrackFileOptions {
  readonly path: string;
  readonly fileName: string;
  readonly origin: SubtitleTrackOrigin;
  readonly language?: LanguageTag;
  /** Copy into `subtitles/{episodeId}/` (true for user picks; false when already in app data). */
  readonly copy: boolean;
}

export interface AnimeLibrary extends AnimeApi {
  /** Register a subtitle file already on disk (downloads use this). */
  addTrackFromFile(episodeId: string, options: AddTrackFileOptions): Promise<SubtitleTrack>;
  /** Persist pending (debounced) progress. */
  flush(): Promise<void>;
  autoFetchJimaku(
    seriesId: string,
    options?: { readonly entryId?: number; readonly aliases?: readonly string[]; readonly anilistId?: number },
  ): Promise<readonly DownloadTask[]>;
}

export interface AnimeLibraryHooks {
  readonly startDownload: (request: DownloadRequest) => Promise<DownloadTask>;
}

interface MediaScan {
  readonly root: string;
  readonly videos: readonly FsEntry[];
  readonly subs: readonly FsEntry[];
}

function isVideo(name: string): boolean {
  return VIDEO_EXT[extname(name)] !== undefined;
}
function isSubtitle(name: string): boolean {
  return SUBTITLE_EXT[extname(name)] !== undefined;
}

/** Attach each subtitle to the video whose stem is its longest prefix, else to the unique same-episode video. */
export function matchSidecars(videos: readonly FsEntry[], subs: readonly FsEntry[]): Map<string, FsEntry[]> {
  const out = new Map<string, FsEntry[]>(videos.map((v) => [v.path, []]));
  const episodeOf = new Map(videos.map((v) => [v.path, parseEpisodeName(v.name).episode]));
  for (const sub of subs) {
    const subStem = stem(sub.name).toLowerCase();
    let best: FsEntry | undefined;
    for (const video of videos) {
      const videoStem = stem(video.name).toLowerCase();
      if (subStem.startsWith(videoStem) && (best === undefined || videoStem.length > stem(best.name).length)) best = video;
    }
    if (best === undefined) {
      const n = parseEpisodeName(sub.name).episode;
      const candidates = n === undefined ? [] : videos.filter((v) => episodeOf.get(v.path) === n);
      if (candidates.length === 1) best = candidates[0];
    }
    if (best !== undefined) out.get(best.path)?.push(sub);
  }
  return out;
}

/** Choose a default track: preferred languages in order, else the first track. */
function pickDefault(tracks: readonly StoredTrack[], preferred: readonly LanguageTag[]): string | undefined {
  for (const lang of preferred) {
    const hit = tracks.find((t) => t.language === lang);
    if (hit) return hit.id;
  }
  return tracks[0]?.id;
}

function sortEpisodes(a: StoredEpisode, b: StoredEpisode): number {
  const ea = a.parsedName.episode ?? Number.MAX_SAFE_INTEGER;
  const eb = b.parsedName.episode ?? Number.MAX_SAFE_INTEGER;
  return ea - eb || compareNatural(a.fileName, b.fileName);
}

export function createAnimeLibrary(ctx: HostContext, hooks: AnimeLibraryHooks): AnimeLibrary {
  const { db, deps, dirs } = ctx;
  const cueCache = new Map<string, { stamp: string; parsed: ParsedSubtitleTrack }>();
  const subtitleClient = createSubtitleSearchClient({
    fetch: deps.fetch,
    jimakuApiKey: () => ctx.settings.current().anime.jimakuApiKey,
  });

  const progress = new KeyedDebouncer<PlaybackProgress>(deps.progressDebounceMs, async (episodeId, value) => {
    const tx = db.transaction(['episodes', 'series'], 'readwrite');
    const episode = await tx.objectStore('episodes').get(episodeId);
    if (episode) {
      await tx.objectStore('episodes').put({ ...episode, progress: value });
      const series = await tx.objectStore('series').get(episode.seriesId);
      if (series) await tx.objectStore('series').put({ ...series, lastWatchedEpisodeId: episodeId, lastWatchedAt: value.updatedAt });
    }
    await tx.done;
  });

  const requireSeries = async (seriesId: string): Promise<StoredSeries> => {
    const series = await db.get('series', seriesId);
    if (!series) throw new KotoriError('not-found', `series not found: ${seriesId}`);
    return series;
  };
  const requireEpisode = async (episodeId: string): Promise<StoredEpisode> => {
    const episode = await db.get('episodes', episodeId);
    if (!episode) throw new KotoriError('not-found', `episode not found: ${episodeId}`);
    return episode;
  };
  const requireTrack = async (trackId: string): Promise<StoredTrack> => {
    const track = await db.get('tracks', trackId);
    if (!track) throw new KotoriError('not-found', `subtitle track not found: ${trackId}`);
    return track;
  };

  const tracksOf = async (episodeId: string): Promise<StoredTrack[]> => {
    const tracks = await db.getAllFromIndex('tracks', 'byEpisode', episodeId);
    return tracks.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || compareNatural(a.label, b.label));
  };

  const hydrate = async (stored: StoredEpisode): Promise<AnimeEpisode> => {
    const pending = progress.peek(stored.id);
    const p = pending ?? stored.progress;
    return {
      ...stored,
      ...(p === undefined ? {} : { progress: p }),
      subtitleTracks: await tracksOf(stored.id),
      mediaUrl: deps.convertFileSrc(stored.filePath),
    };
  };

  /** List videos + subtitles of a directory (up to 4 nested folder levels) or a single video. */
  const scanMedia = async (path: string): Promise<MediaScan> => {
    const entry = await deps.fs.stat(path);
    if (!entry) throw new KotoriError('not-found', `path not found: ${path}`);
    if (entry.kind === 'file') {
      if (!isVideo(entry.name)) throw new KotoriError('invalid-argument', `not a video file: ${entry.name}`);
      const root = dirname(path);
      const siblings = await deps.fs.readdir(root).catch(() => [] as readonly FsEntry[]);
      return { root, videos: [{ ...entry, path }], subs: siblings.filter((s) => s.kind === 'file' && isSubtitle(s.name)) };
    }
    const videos: FsEntry[] = [];
    const subs: FsEntry[] = [];
    const walkDir = async (dirPath: string, depth: number): Promise<void> => {
      const children = await deps.fs.readdir(dirPath).catch(() => [] as readonly FsEntry[]);
      for (const child of children) {
        if (child.name.startsWith('.') || child.name.startsWith('@')) continue;
        if (child.kind === 'file') {
          if (isVideo(child.name)) videos.push(child);
          else if (isSubtitle(child.name)) subs.push(child);
        } else if (depth > 0) {
          await walkDir(child.path, depth - 1);
        }
      }
    };
    await walkDir(path, 4);
    return { root: path, videos, subs };
  };

  /** Scan `sourcePath` and reconcile series/episodes/external tracks in one transaction. */
  const scanSeries = async (
    sourcePath: string,
    titleOverride: string | undefined,
    existing: StoredSeries | undefined,
    anilistId?: number,
    coverUrl?: string,
  ): Promise<AnimeSeries> => {
    const scan = await scanMedia(sourcePath);
    if (scan.videos.length === 0) throw new KotoriError('invalid-argument', `no video files found in ${sourcePath}`);
    const seriesId = existing?.id ?? stableId('ser', sourcePath);
    const now = deps.now();
    const preferred = ctx.settings.current().anime.preferredSubtitleLanguages;
    const oldEpisodes = await db.getAllFromIndex('episodes', 'bySeries', seriesId);
    const oldById = new Map(oldEpisodes.map((e) => [e.id, e]));
    const oldTracks = (await Promise.all(oldEpisodes.map((e) => db.getAllFromIndex('tracks', 'byEpisode', e.id)))).flat();
    const oldTrackById = new Map(oldTracks.map((t) => [t.id, t]));
    const sidecars = matchSidecars(scan.videos, scan.subs);

    const episodes: StoredEpisode[] = [];
    const tracks: StoredTrack[] = [];
    for (const video of scan.videos) {
      const id = stableId('ep', video.path);
      const prev = oldById.get(id);
      const parsedName = parseEpisodeName(video.name);
      const epTitle =
        parsedName.episode !== undefined
          ? `第${parsedName.episode}話`
          : parsedName.title !== ''
            ? parsedName.title
            : stem(video.name);
      const episode: StoredEpisode = {
        id,
        seriesId,
        title: epTitle,
        fileName: video.name,
        filePath: video.path,
        container: VIDEO_EXT[extname(video.name)] ?? 'other',
        sizeBytes: video.sizeBytes,
        parsedName,
        ...(prev?.durationMs === undefined ? {} : { durationMs: prev.durationMs }),
        ...(prev?.progress === undefined ? {} : { progress: prev.progress }),
      };
      episodes.push(episode);
      const episodeTracks: StoredTrack[] = oldTracks.filter((t) => t.episodeId === id && t.origin !== 'external');
      for (const sub of sidecars.get(video.path) ?? []) {
        const trackId = stableId('trk', sub.path);
        const prevTrack = oldTrackById.get(trackId);
        const language = detectSubtitleLanguageFromName(sub.name);
        const rawSuffix = stem(sub.name).startsWith(stem(video.name))
          ? stem(sub.name).slice(stem(video.name).length).replace(/^[.\s_-]+/, '')
          : '';
        const extUpper = extname(sub.name).toUpperCase();
        const langUpper = language ? language.toUpperCase() : 'External';
        const cleanLabel =
          rawSuffix === '' || rawSuffix.toLowerCase() === (language ?? '').toLowerCase()
            ? `${langUpper} (${extUpper})`
            : `${rawSuffix} · ${extUpper}`;
        episodeTracks.push({
          id: trackId,
          episodeId: id,
          origin: 'external',
          format: SUBTITLE_EXT[extname(sub.name)] ?? 'srt',
          label: cleanLabel,
          ...(language === undefined ? {} : { language }),
          filePath: sub.path,
          isDefault: prevTrack?.isDefault ?? false,
          ...(prevTrack?.cueCount === undefined ? {} : { cueCount: prevTrack.cueCount }),
          delayMs: prevTrack?.delayMs ?? 0,
        });
      }
      if (!episodeTracks.some((t) => t.isDefault)) {
        const def = pickDefault(episodeTracks, preferred);
        for (let i = 0; i < episodeTracks.length; i++) {
          const t = episodeTracks[i];
          if (t && t.id === def) episodeTracks[i] = { ...t, isDefault: true };
        }
      }
      tracks.push(...episodeTracks);
    }
    episodes.sort(sortEpisodes);

    const titles = new Map<string, number>();
    for (const e of episodes) if (e.parsedName.title !== '') titles.set(e.parsedName.title, (titles.get(e.parsedName.title) ?? 0) + 1);
    const commonTitle = [...titles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const resolvedAnilistId = anilistId ?? existing?.anilistId;
    const resolvedCoverUrl = coverUrl ?? existing?.coverUrl;
    const fallbackRootName = basename(scan.root);
    const cleanedFallbackTitle = parseEpisodeName(fallbackRootName).title || fallbackRootName;
    const series: StoredSeries = {
      ...(existing ?? {}),
      id: seriesId,
      title: titleOverride ?? existing?.title ?? commonTitle ?? cleanedFallbackTitle,
      sourcePath,
      episodeCount: episodes.length,
      addedAt: existing?.addedAt ?? now,
      ...(resolvedAnilistId !== undefined ? { anilistId: resolvedAnilistId } : {}),
      ...(resolvedCoverUrl !== undefined ? { coverUrl: resolvedCoverUrl } : {}),
    };

    const keepEpisode = new Set(episodes.map((e) => e.id));
    const keepTrack = new Set(tracks.map((t) => t.id));
    const tx = db.transaction(['series', 'episodes', 'tracks'], 'readwrite');
    await Promise.all([
      tx.objectStore('series').put(series),
      ...episodes.map((e) => tx.objectStore('episodes').put(e)),
      ...tracks.map((t) => tx.objectStore('tracks').put(t)),
      ...oldEpisodes.filter((e) => !keepEpisode.has(e.id)).map((e) => tx.objectStore('episodes').delete(e.id)),
      ...oldTracks.filter((t) => !keepTrack.has(t.id)).map((t) => tx.objectStore('tracks').delete(t.id)),
    ]);
    await tx.done;
    ctx.emit({ type: 'library-changed', scope: 'anime' });
    return series;
  };

  const addTrackFromFile = async (episodeId: string, options: AddTrackFileOptions): Promise<SubtitleTrack> => {
    await requireEpisode(episodeId);
    const bytes = await deps.fs.readFile(options.path);
    return addTrackBytes(episodeId, bytes, options.fileName, options.origin, options.language, options.copy ? undefined : options.path);
  };

  /** Validate + (optionally) store bytes under `subtitles/{episodeId}/`, then register the track. */
  const addTrackBytes = async (
    episodeId: string,
    bytes: Uint8Array,
    rawFileName: string,
    origin: SubtitleTrackOrigin,
    language: LanguageTag | undefined,
    existingPath: string | undefined,
  ): Promise<SubtitleTrack> => {
    const fileName = safeFileName(rawFileName);
    let parsed: ParsedSubtitleTrack;
    try {
      parsed = parseSubtitle({ bytes, fileName });
    } catch (error) {
      throw new KotoriError('parse', `cannot parse subtitle ${fileName}: ${KotoriError.wrap(error).message}`, { cause: error });
    }
    if (parsed.cues.length === 0) throw new KotoriError('parse', `no subtitle cues found in ${fileName}`, { details: { warnings: parsed.warnings } });
    let filePath = existingPath;
    if (filePath === undefined) {
      const dir = joinPath(dirs.subtitles, episodeId);
      filePath = joinPath(dir, fileName);
      if (await deps.fs.stat(filePath)) filePath = joinPath(dir, `${deps.now().toString(36)}-${fileName}`);
      await deps.fs.writeFile(filePath, bytes);
    }
    const siblings = await db.getAllFromIndex('tracks', 'byEpisode', episodeId);
    const lang = language ?? detectSubtitleLanguageFromName(fileName);
    const track: StoredTrack = {
      id: uniqueId('trk', deps.now()),
      episodeId,
      origin,
      format: parsed.info.format,
      label: fileName,
      ...(lang === undefined ? {} : { language: lang }),
      filePath,
      isDefault: !siblings.some((t) => t.isDefault),
      cueCount: parsed.cues.length,
      delayMs: 0,
    };
    await db.put('tracks', track);
    ctx.emit({ type: 'library-changed', scope: 'anime' });
    return track;
  };

  return {
    async listSeries() {
      const all = await db.getAll('series');
      return all.sort((a, b) => (b.lastWatchedAt ?? b.addedAt) - (a.lastWatchedAt ?? a.addedAt) || compareNatural(a.title, b.title));
    },
    getSeries: requireSeries,
    async listEpisodes(seriesId) {
      await requireSeries(seriesId);
      const episodes = await db.getAllFromIndex('episodes', 'bySeries', seriesId);
      return Promise.all(episodes.sort(sortEpisodes).map(hydrate));
    },
    async getEpisode(episodeId) {
      return hydrate(await requireEpisode(episodeId));
    },
    async importSeries(request) {
      if (request.path === '') throw new KotoriError('invalid-argument', 'path is required');
      const existing = await db.get('series', stableId('ser', request.path));
      return scanSeries(request.path, request.titleOverride, existing, request.anilistId, request.coverUrl);
    },
    async removeSeries(seriesId, deleteFiles = false) {
      await requireSeries(seriesId);
      const episodes = await db.getAllFromIndex('episodes', 'bySeries', seriesId);
      const tracks = (await Promise.all(episodes.map((e) => db.getAllFromIndex('tracks', 'byEpisode', e.id)))).flat();
      const tx = db.transaction(['series', 'episodes', 'tracks'], 'readwrite');
      await Promise.all([
        tx.objectStore('series').delete(seriesId),
        ...episodes.map((e) => tx.objectStore('episodes').delete(e.id)),
        ...tracks.map((t) => tx.objectStore('tracks').delete(t.id)),
      ]);
      await tx.done;
      for (const e of episodes) {
        cueCache.delete(e.id);
        await deps.fs.remove(joinPath(dirs.subtitles, e.id));
        if (deleteFiles) await deps.fs.remove(e.filePath);
      }
      if (deleteFiles) for (const t of tracks) if (t.origin === 'external' && t.filePath !== undefined) await deps.fs.remove(t.filePath);
      ctx.emit({ type: 'library-changed', scope: 'anime' });
    },
    async rescanSeries(seriesId) {
      const series = await requireSeries(seriesId);
      return scanSeries(series.sourcePath, undefined, series);
    },
    async getCues(trackId) {
      const track = await requireTrack(trackId);
      if (track.filePath === undefined) throw new KotoriError('unsupported', 'embedded subtitle tracks are not available on Android');
      const st = await deps.fs.stat(track.filePath);
      if (!st) throw new KotoriError('not-found', `subtitle file missing: ${track.filePath}`);
      const stamp = `${st.mtimeMs}:${st.sizeBytes}`;
      let cached = cueCache.get(trackId);
      if (cached?.stamp === stamp) {
        cueCache.delete(trackId); // LRU touch
        cueCache.set(trackId, cached);
      } else {
        const parsed = parseSubtitle({ bytes: await deps.fs.readFile(track.filePath), fileName: basename(track.filePath) });
        cached = { stamp, parsed };
        cueCache.delete(trackId);
        cueCache.set(trackId, cached);
        while (cueCache.size > CUE_CACHE_SIZE) {
          const oldest = cueCache.keys().next().value;
          if (oldest === undefined) break;
          cueCache.delete(oldest);
        }
        if (track.cueCount !== parsed.cues.length) await db.put('tracks', { ...track, cueCount: parsed.cues.length });
      }
      const { parsed } = cached;
      const info = parsed.info.language === undefined && track.language !== undefined ? { ...parsed.info, language: track.language } : parsed.info;
      return { info, cues: applyDelay(parsed.cues, track.delayMs), warnings: parsed.warnings };
    },
    async addSubtitleTrack(episodeId, input) {
      await requireEpisode(episodeId);
      let bytes: Uint8Array;
      if (input.content !== undefined) bytes = new TextEncoder().encode(input.content);
      else if (input.path !== undefined) bytes = await deps.fs.readFile(input.path);
      else throw new KotoriError('invalid-argument', 'either path or content is required');
      return addTrackBytes(episodeId, bytes, input.fileName, 'imported', input.language, undefined);
    },
    extractEmbeddedTrack() {
      return Promise.reject(new KotoriError('unsupported', 'embedded subtitle extraction requires ffmpeg (desktop only)'));
    },
    async removeSubtitleTrack(trackId) {
      const track = await requireTrack(trackId);
      await db.delete('tracks', trackId);
      cueCache.delete(trackId);
      if (track.filePath !== undefined && isWithin(track.filePath, dirs.subtitles)) await deps.fs.remove(track.filePath);
      if (track.isDefault) {
        const rest = await db.getAllFromIndex('tracks', 'byEpisode', track.episodeId);
        const next = pickDefault(rest, ctx.settings.current().anime.preferredSubtitleLanguages);
        const nextTrack = rest.find((t) => t.id === next);
        if (nextTrack) await db.put('tracks', { ...nextTrack, isDefault: true });
      }
      ctx.emit({ type: 'library-changed', scope: 'anime' });
    },
    async setTrackDelay(trackId, delayMs) {
      if (!Number.isFinite(delayMs)) throw new KotoriError('invalid-argument', 'delayMs must be a finite number');
      const track = await requireTrack(trackId);
      const next: StoredTrack = { ...track, delayMs: Math.round(delayMs) };
      await db.put('tracks', next);
      return next;
    },
    async setDefaultTrack(episodeId, trackId) {
      const tracks = await db.getAllFromIndex('tracks', 'byEpisode', episodeId);
      if (!tracks.some((t) => t.id === trackId)) throw new KotoriError('not-found', `track ${trackId} not on episode ${episodeId}`);
      const tx = db.transaction('tracks', 'readwrite');
      await Promise.all(tracks.map((t) => tx.store.put({ ...t, isDefault: t.id === trackId })));
      await tx.done;
    },
    saveProgress(episodeId, value) {
      return progress.schedule(episodeId, value);
    },
    async autoFetchJimaku(seriesId, options) {
      const series = await requireSeries(seriesId);
      const anilistId = options?.anilistId ?? series.anilistId;
      let entry: JimakuEntry | undefined;
      const entryId = options?.entryId ?? series.jimakuEntryId;
      if (entryId === undefined) {
        const queryCandidates = [series.title, ...(options?.aliases ?? [])]
          .map((s) => s.trim())
          .filter((s, i, a) => s.length > 0 && a.indexOf(s) === i);
        const found = await subtitleClient.searchEntries({
          query: queryCandidates.join('|'),
          ...(anilistId !== undefined ? { anilistId } : {}),
        });
        entry = found[0];
      } else {
        entry = { id: entryId, name: series.title, flags: { anime: true, unverified: false, external: false, movie: false, adult: false } };
      }
      if (entry === undefined) throw new KotoriError('not-found', `no Jimaku entry for "${series.title}"`);
      const files = await subtitleClient.listFiles(entry.id);
      const episodes = await Promise.all((await db.getAllFromIndex('episodes', 'bySeries', seriesId)).map(hydrate));
      const matches = matchJimakuFilesToEpisodes(files, episodes);
      const tasks: DownloadTask[] = [];
      for (const episode of episodes) {
        const file = matches.get(episode.id);
        if (!file) continue;
        if (episode.subtitleTracks.some((t) => t.origin === 'jimaku' && t.label === safeFileName(file.name))) continue;
        tasks.push(
          await hooks.startDownload({
            source: { kind: 'jimaku', entry, file, episodeId: episode.id, seriesId },
            title: file.name,
            autoImport: true,
          }),
        );
      }
      if (tasks.length === 0) {
        const pack = files.find((f) => f.archiveFormat === 'zip');
        if (pack) {
          tasks.push(
            await hooks.startDownload({
              source: { kind: 'jimaku', entry, file: pack, seriesId },
              title: pack.name,
              autoImport: true,
            }),
          );
        }
      }
      if (series.jimakuEntryId !== entry.id || (anilistId !== undefined && series.anilistId !== anilistId)) {
        await db.put('series', { ...series, jimakuEntryId: entry.id, ...(anilistId !== undefined ? { anilistId } : {}) });
      }
      return tasks;
    },
    addTrackFromFile,
    flush: () => progress.flushAll(),
  };
}
