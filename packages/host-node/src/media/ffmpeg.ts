/**
 * Optional system ffmpeg/ffprobe integration (ARCHITECTURE.md §5.3): probe
 * streams, list embedded text subtitles, extract one to a file. We only
 * `spawn` user-installed binaries — nothing is bundled or compiled.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { KotoriError } from '@kotori/core';
import type { LanguageTag, SubtitleFormat } from '@kotori/core';

export interface FfmpegPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Check that `binPath` is executable and can actually be spawned (`-version` exits 0). */
export async function canRunBinary(binPath: string, timeoutMs = 3_000): Promise<boolean> {
  if (!(await isExecutable(binPath))) return false;
  try {
    await runProcess(binPath, ['-version'], { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

const FATAL_SPAWN_CODES = new Set(['EBADARCH', 'ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'UNKNOWN SYSTEM ERROR -86']);
const FATAL_SPAWN_MESSAGE_RE = /\b(?:EBADARCH|ENOENT|EACCES|EPERM|ENOEXEC)\b|Unknown system error -86/i;

/**
 * True when `error` (or its `cause` chain) indicates an unrecoverable spawn
 * failure (`EBADARCH` / `Unknown system error -86` on Apple Silicon macOS
 * without Rosetta 2, missing binary, permission error, bad executable format).
 */
export function isFatalSpawnError(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 6; depth++) {
    if (typeof cur === 'string') {
      if (!/\bexited with \d+:/i.test(cur) && FATAL_SPAWN_MESSAGE_RE.test(cur)) return true;
      break;
    }
    if (typeof cur === 'object') {
      const rec = cur as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
      if (rec.errno === -86) return true;
      if (typeof rec.code === 'string' && FATAL_SPAWN_CODES.has(rec.code.toUpperCase())) return true;
      if (
        typeof rec.message === 'string' &&
        !/\bexited with \d+:/i.test(rec.message) &&
        FATAL_SPAWN_MESSAGE_RE.test(rec.message)
      ) {
        return true;
      }
      cur = rec.cause;
      continue;
    }
    break;
  }
  return false;
}

/** Search `$KOTORI_FFMPEG_DIR`, `$PATH` and common Homebrew/Linux locations. */
export async function findFfmpeg(
  env: NodeJS.ProcessEnv = process.env,
  verify: (path: string) => Promise<boolean> = canRunBinary,
): Promise<FfmpegPaths | undefined> {
  const dirs = [
    ...new Set([
      ...(env['KOTORI_FFMPEG_DIR'] ? [env['KOTORI_FFMPEG_DIR']] : []),
      ...(env['PATH'] ?? '').split(delimiter).filter(Boolean),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/snap/bin',
    ]),
  ];
  const check = async (binPath: string): Promise<boolean> => {
    try {
      return await verify(binPath);
    } catch {
      return false;
    }
  };
  for (const dir of dirs) {
    const ffmpeg = join(dir, 'ffmpeg');
    const ffprobe = join(dir, 'ffprobe');
    if ((await check(ffmpeg)) && (await check(ffprobe))) return { ffmpeg, ffprobe };
  }
  return undefined;
}

/** Run a process, collecting stdout/stderr (rejects on non-zero exit). */
export function runProcess(command: string, args: readonly string[], options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new KotoriError('io', `${command} timed out`));
        }, options.timeoutMs)
      : undefined;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new KotoriError('io', `${command}: ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new KotoriError('io', `${command} exited with ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

export interface ProbedSubtitleStream {
  readonly index: number;
  readonly codec: string;
  readonly format: SubtitleFormat;
  readonly language?: LanguageTag;
  readonly title?: string;
  readonly isDefault: boolean;
}

export interface ProbeResult {
  readonly durationMs?: number;
  readonly videoCodec?: string;
  readonly audioCodecs: readonly string[];
  readonly subtitles: readonly ProbedSubtitleStream[];
  /** Human-readable playback warnings (codecs Chromium cannot decode). */
  readonly warnings: readonly string[];
}

interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

/** Text subtitle codecs we can extract → resulting file format. */
export const TEXT_SUBTITLE_CODECS: Readonly<Record<string, SubtitleFormat>> = { ass: 'ass', ssa: 'ass', subrip: 'srt', srt: 'srt', webvtt: 'vtt', mov_text: 'srt', text: 'srt' };

const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO = new Set(['aac', 'opus', 'vorbis', 'flac', 'mp3']);

/** ISO-639-2 → short tag for the common cases. */
function normaliseLanguage(lang: string | undefined): LanguageTag | undefined {
  if (!lang || lang.toLowerCase() === 'und') return undefined;
  const map: Record<string, string> = { jpn: 'ja', eng: 'en', chi: 'zh', zho: 'zh', kor: 'ko' };
  return map[lang.toLowerCase()] ?? lang.toLowerCase();
}

/** Interpret ffprobe JSON (exported for tests). */
export function interpretProbe(json: string): ProbeResult {
  const data = JSON.parse(json) as { streams?: RawStream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.['attached_pic'] !== 1);
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name ?? 'unknown');
  const subtitles: ProbedSubtitleStream[] = [];
  for (const s of streams) {
    if (s.codec_type !== 'subtitle' || s.index === undefined) continue;
    const format = TEXT_SUBTITLE_CODECS[s.codec_name ?? ''];
    if (!format) continue;
    const language = normaliseLanguage(s.tags?.['language']);
    const title = s.tags?.['title'];
    subtitles.push({
      index: s.index,
      codec: s.codec_name ?? '',
      format,
      isDefault: s.disposition?.['default'] === 1,
      ...(language ? { language } : {}),
      ...(title ? { title } : {}),
    });
  }
  const warnings: string[] = [];
  if (video?.codec_name && !BROWSER_VIDEO.has(video.codec_name)) warnings.push(`Video codec ${video.codec_name} may not play in the browser (H.264/VP9/AV1 supported).`);
  for (const a of audio) if (!BROWSER_AUDIO.has(a)) warnings.push(`Audio codec ${a} may not play in the browser (AAC/Opus/Vorbis/FLAC supported).`);
  const duration = Number(data.format?.duration);
  return {
    audioCodecs: audio,
    subtitles,
    warnings,
    ...(Number.isFinite(duration) ? { durationMs: Math.round(duration * 1000) } : {}),
    ...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
  };
}

export async function probeStreams(paths: FfmpegPaths, file: string): Promise<ProbeResult> {
  const { stdout } = await runProcess(paths.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', file], { timeoutMs: 30_000 });
  return interpretProbe(stdout);
}

/** `ffmpeg -y -i file -map 0:{i} out.{ass|srt|vtt}` (ssa→ass, mov_text→srt). */
export async function extractSubtitleStream(paths: FfmpegPaths, file: string, streamIndex: number, outPath: string): Promise<void> {
  const ext = outPath.toLowerCase().endsWith('.vtt') ? 'webvtt' : outPath.toLowerCase().endsWith('.srt') ? 'srt' : 'ass';
  await runProcess(paths.ffmpeg, ['-y', '-v', 'error', '-i', file, '-map', `0:${streamIndex}`, '-c:s', ext, outPath], { timeoutMs: 5 * 60_000 });
}
