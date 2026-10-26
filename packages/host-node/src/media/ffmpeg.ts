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

/** Search `$KOTORI_FFMPEG_DIR`, `$PATH` and common Homebrew/Linux locations. */
export async function findFfmpeg(env: NodeJS.ProcessEnv = process.env): Promise<FfmpegPaths | undefined> {
  const dirs = [
    ...(env['KOTORI_FFMPEG_DIR'] ? [env['KOTORI_FFMPEG_DIR']] : []),
    ...(env['PATH'] ?? '').split(delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/snap/bin',
  ];
  for (const dir of dirs) {
    const ffmpeg = join(dir, 'ffmpeg');
    const ffprobe = join(dir, 'ffprobe');
    if ((await isExecutable(ffmpeg)) && (await isExecutable(ffprobe))) return { ffmpeg, ffprobe };
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
