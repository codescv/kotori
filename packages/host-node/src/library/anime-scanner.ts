/**
 * Anime folder scanner: walks a series directory (or a single video file),
 * groups video files into ordered episodes via `parseEpisodeName`, and finds
 * sidecar subtitles (`*.srt|.ass|.ssa|.vtt`, language suffixes) by basename
 * prefix — falling back to episode-number matching within the same folder.
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { LanguageTag, ParsedEpisodeName, SubtitleFormat, VideoContainer } from '@kotori/core';
import { compareNatural, detectSubtitleLanguageFromName, parseEpisodeName } from '@kotori/core';

export const VIDEO_EXTENSIONS: Readonly<Record<string, VideoContainer>> = {
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.mkv': 'mkv',
  '.webm': 'webm',
  '.mov': 'other',
  '.avi': 'other',
  '.ts': 'other',
};

export const SUBTITLE_EXTENSIONS: Readonly<Record<string, SubtitleFormat>> = { '.srt': 'srt', '.ass': 'ass', '.ssa': 'ass', '.vtt': 'vtt' };

const COVER_NAMES = /^(cover|folder|poster|fanart)\.(jpe?g|png|webp)$/i;

export interface ScannedSidecar {
  readonly filePath: string;
  readonly fileName: string;
  readonly format: SubtitleFormat;
  readonly language?: LanguageTag;
  readonly label: string;
}

export interface ScannedEpisode {
  readonly filePath: string;
  readonly fileName: string;
  readonly container: VideoContainer;
  readonly sizeBytes: number;
  readonly parsedName: ParsedEpisodeName;
  readonly title: string;
  readonly sidecars: readonly ScannedSidecar[];
}

export interface ScannedSeries {
  readonly sourcePath: string;
  readonly title: string;
  readonly coverPath?: string;
  readonly episodes: readonly ScannedEpisode[];
}

interface FileEntry {
  readonly path: string;
  readonly name: string;
  readonly dir: string;
  readonly size: number;
}

async function walk(dir: string, depth: number, out: FileEntry[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('@')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth > 0) await walk(full, depth - 1, out);
    } else if (st.isFile()) {
      out.push({ path: full, name, dir, size: st.size });
    }
  }
}

function stem(name: string): string {
  return name.slice(0, name.length - extname(name).length);
}

/** `subStem` belongs to `videoStem` when equal or followed by a separator (`.ja`, ` [CC]`, `_en`, `-jp`). */
export function stemMatches(subStem: string, videoStem: string): boolean {
  if (!subStem.startsWith(videoStem)) return false;
  const next = subStem.charAt(videoStem.length);
  return next === '' || /[.\s_\-[(（【]/.test(next);
}

/** Label like `日本語 (ass)` / `external.srt`. */
function sidecarLabel(fileName: string, videoStem: string, language: LanguageTag | undefined, format: SubtitleFormat): string {
  const suffix = stem(fileName).slice(videoStem.length).replace(/^[.\s_-]+/, '');
  const lang = language ? language.toUpperCase() : '';
  const parts = [lang, suffix && suffix.toLowerCase() !== (language ?? '').toLowerCase() ? suffix : ''].filter(Boolean);
  return `${parts.join(' ') || 'External'} (${format})`;
}

/** Order: season → episode → natural file name. */
function compareEpisodes(a: ScannedEpisode, b: ScannedEpisode): number {
  const sa = a.parsedName.season ?? 0;
  const sb = b.parsedName.season ?? 0;
  if (sa !== sb) return sa - sb;
  const ea = a.parsedName.episode ?? Number.MAX_SAFE_INTEGER;
  const eb = b.parsedName.episode ?? Number.MAX_SAFE_INTEGER;
  if (ea !== eb) return ea - eb;
  return compareNatural(a.fileName, b.fileName);
}

/** Most common parsed title among episodes (the series title), else folder name. */
function inferTitle(episodes: readonly ScannedEpisode[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const e of episodes) if (e.parsedName.title) counts.set(e.parsedName.title, (counts.get(e.parsedName.title) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [title, n] of counts) {
    if (n > bestCount) {
      best = title;
      bestCount = n;
    }
  }
  return best ?? fallback;
}

/** Match sidecars to videos: basename-prefix first, then same-folder episode number. */
export function matchSidecars(videos: readonly FileEntry[], subs: readonly FileEntry[]): Map<string, ScannedSidecar[]> {
  const out = new Map<string, ScannedSidecar[]>(videos.map((v) => [v.path, []]));
  const videosByDir = new Map<string, FileEntry[]>();
  for (const v of videos) videosByDir.set(v.dir, [...(videosByDir.get(v.dir) ?? []), v]);
  for (const sub of subs) {
    const subStem = stem(sub.name);
    const format = SUBTITLE_EXTENSIONS[extname(sub.name).toLowerCase()];
    if (!format) continue;
    const siblings = videosByDir.get(sub.dir) ?? [];
    // 1) longest video stem that prefixes the subtitle stem
    let owner: FileEntry | undefined;
    for (const v of siblings) {
      const vs = stem(v.name);
      if (stemMatches(subStem, vs) && (!owner || vs.length > stem(owner.name).length)) owner = v;
    }
    // 2) episode-number match (or the only video in the folder)
    if (!owner) {
      const ep = parseEpisodeName(sub.name).episode;
      const byEp = ep === undefined ? [] : siblings.filter((v) => parseEpisodeName(v.name).episode === ep);
      const only = siblings.length === 1 ? siblings[0] : undefined;
      if (byEp.length === 1) owner = byEp[0];
      // A lone video only adopts subtitles that don't name a *different* episode.
      else if (only && (ep === undefined || parseEpisodeName(only.name).episode === undefined)) owner = only;
    }
    if (!owner) continue;
    const language = detectSubtitleLanguageFromName(sub.name);
    const ownerStem = stemMatches(subStem, stem(owner.name)) ? stem(owner.name) : subStem;
    const sidecar: ScannedSidecar = {
      filePath: sub.path,
      fileName: sub.name,
      format,
      label: sidecarLabel(sub.name, ownerStem, language, format),
      ...(language ? { language } : {}),
    };
    out.get(owner.path)?.push(sidecar);
  }
  // Japanese first, then by name.
  for (const list of out.values()) list.sort((a, b) => Number(b.language === 'ja') - Number(a.language === 'ja') || compareNatural(a.fileName, b.fileName));
  return out;
}

/** Scan a series directory (depth ≤ 3) or a single video file. */
export async function scanAnimeFolder(path: string, options: { maxDepth?: number } = {}): Promise<ScannedSeries> {
  const st = await stat(path);
  const files: FileEntry[] = [];
  let rootDir = path;
  if (st.isFile()) {
    rootDir = dirname(path);
    const all: FileEntry[] = [];
    await walk(rootDir, 0, all);
    const videoStem = stem(basename(path));
    for (const f of all) {
      if (f.path === path || (SUBTITLE_EXTENSIONS[extname(f.name).toLowerCase()] && stemMatches(stem(f.name), videoStem))) files.push(f);
    }
  } else {
    await walk(path, options.maxDepth ?? 3, files);
  }
  const videos = files.filter((f) => VIDEO_EXTENSIONS[extname(f.name).toLowerCase()] !== undefined);
  const subs = files.filter((f) => SUBTITLE_EXTENSIONS[extname(f.name).toLowerCase()] !== undefined);
  const sidecars = matchSidecars(videos, subs);
  const episodes = videos
    .map((v): ScannedEpisode => {
      const parsedName = parseEpisodeName(v.name);
      const epLabel =
        parsedName.episode !== undefined
          ? `第${parsedName.episode}話`
          : parsedName.title !== ''
            ? parsedName.title
            : stem(v.name);
      return {
        filePath: v.path,
        fileName: v.name,
        container: VIDEO_EXTENSIONS[extname(v.name).toLowerCase()] ?? 'other',
        sizeBytes: v.size,
        parsedName,
        title: epLabel,
        sidecars: sidecars.get(v.path) ?? [],
      };
    })
    .sort(compareEpisodes);
  const cover = files.find((f) => f.dir === rootDir && COVER_NAMES.test(f.name));
  const rawFallback = basename(st.isFile() ? stem(path) : path);
  const cleanedFallback = parseEpisodeName(rawFallback).title || rawFallback;
  const title = inferTitle(episodes, cleanedFallback);
  return cover ? { sourcePath: path, title, coverPath: cover.path, episodes } : { sourcePath: path, title, episodes };
}
