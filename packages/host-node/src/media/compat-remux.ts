/**
 * Apple WebKit compatibility remux for `GET|HEAD /media/:episodeId`.
 *
 * Safari / iOS `AVFoundation` cannot open Matroska (`.mkv`), AVI or MPEG-TS
 * containers at all, even though the hardware decodes HEVC Main 10 just fine
 * when it is packaged as ISO BMFF with an `hvc1` sample entry. When a request
 * asks for `?compat=1`, or comes from a non-Chromium AppleWebKit browser for
 * one of those containers, we remux the file once with the user's system
 * ffmpeg into a cached faststart `.mp4` (video copied when it is H.264/HEVC,
 * audio → stereo AAC) and stream that instead. If ffmpeg is unavailable or
 * every attempt fails the caller falls back to serving the original file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { interpretProbe, runProcess, type FfmpegPaths } from './ffmpeg';

/** Containers Apple WebKit cannot demux. */
export const APPLE_INCOMPATIBLE_CONTAINERS: ReadonlySet<string> = new Set(['.mkv', '.avi', '.ts']);

/** Video codecs that can be stream-copied into an MP4 Apple can play. */
const COPYABLE_VIDEO = new Set(['h264', 'hevc']);

/** True for Safari / iOS WebKit user agents (AppleWebKit but not Chromium-based). */
export function isAppleWebKitUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent || !userAgent.includes('AppleWebKit')) return false;
  return !/\b(?:Chrome|Chromium|Edg)\//.test(userAgent);
}

/** True when the request URL carries `compat=1`. */
export function hasCompatParam(url: string): boolean {
  try {
    return new URL(url, 'http://localhost').searchParams.get('compat') === '1';
  } catch {
    return false;
  }
}

/** Decide whether `filePath` should be served as a compat MP4 for this request. */
export function wantsCompatRemux(filePath: string, requestUrl: string, userAgent: string | null | undefined): boolean {
  if (hasCompatParam(requestUrl)) return true;
  return APPLE_INCOMPATIBLE_CONTAINERS.has(extname(filePath).toLowerCase()) && isAppleWebKitUserAgent(userAgent);
}

/** Stable cache key for a specific revision of a source file. */
export function compatCacheKey(filePath: string, size: number, mtimeMs: number): string {
  return createHash('sha256').update(`${filePath}\0${size}\0${mtimeMs}`).digest('hex').slice(0, 32);
}

export type RemuxVideoMode = { readonly kind: 'copy'; readonly hvc1: boolean } | { readonly kind: 'transcode' };

/** ffmpeg arguments for one remux attempt. */
export function buildRemuxArgs(input: string, output: string, video: RemuxVideoMode): string[] {
  const videoArgs = video.kind === 'copy' ? ['-c:v', 'copy', ...(video.hvc1 ? ['-tag:v', 'hvc1'] : [])] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'];
  return ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-map_chapters', '-1', '-sn', '-dn', ...videoArgs, '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', output];
}

/** Ordered attempts for a source whose primary video codec is `videoCodec` (undefined = unknown). */
export function remuxPlan(videoCodec: string | undefined): RemuxVideoMode[] {
  const transcode: RemuxVideoMode = { kind: 'transcode' };
  if (videoCodec === 'hevc') return [{ kind: 'copy', hvc1: true }, transcode];
  if (videoCodec === 'h264') return [{ kind: 'copy', hvc1: false }, transcode];
  if (videoCodec !== undefined && !COPYABLE_VIDEO.has(videoCodec)) return [transcode];
  // Unknown codec: try HEVC-tagged copy (fails fast on non-HEVC), plain copy, then transcode.
  return [{ kind: 'copy', hvc1: true }, { kind: 'copy', hvc1: false }, transcode];
}

export type ProcessRunner = (command: string, args: readonly string[], options: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

export interface CompatRemuxerOptions {
  /** Current ffmpeg/ffprobe paths (undefined = ffmpeg not installed). */
  readonly ffmpeg: () => FfmpegPaths | undefined;
  /** Defaults to `<os.tmpdir()>/kotori-media-cache`. */
  readonly cacheDir?: string;
  /** Process runner (injected by tests). */
  readonly run?: ProcessRunner;
  /** Called when an attempt / the whole remux fails. */
  readonly onError?: (error: unknown, filePath: string) => void;
}

export interface CompatRemuxer {
  /** Whether a compat remux can be attempted at all (ffmpeg present). */
  available(): boolean;
  /**
   * Return the path of a cached MP4 for `filePath`, remuxing on first use.
   * Concurrent calls for the same source share one ffmpeg job. Resolves
   * `undefined` when ffmpeg is unavailable, the source is missing, or every
   * attempt failed.
   */
  remux(filePath: string): Promise<string | undefined>;
}

const PROBE_TIMEOUT_MS = 30_000;
const COPY_TIMEOUT_MS = 20 * 60_000;
const TRANSCODE_TIMEOUT_MS = 3 * 60 * 60_000;

export function createCompatRemuxer(options: CompatRemuxerOptions): CompatRemuxer {
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'kotori-media-cache');
  const run: ProcessRunner = options.run ?? runProcess;
  const jobs = new Map<string, Promise<string | undefined>>();

  const probeVideoCodec = async (paths: FfmpegPaths, filePath: string): Promise<string | undefined> => {
    try {
      const { stdout } = await run(paths.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', filePath], { timeoutMs: PROBE_TIMEOUT_MS });
      return interpretProbe(stdout).videoCodec;
    } catch {
      return undefined;
    }
  };

  const produce = async (paths: FfmpegPaths, filePath: string, cacheOut: string): Promise<string | undefined> => {
    await mkdir(cacheDir, { recursive: true });
    const plan = remuxPlan(await probeVideoCodec(paths, filePath));
    for (const mode of plan) {
      const tmpOut = `${cacheOut.slice(0, -'.mp4'.length)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp.mp4`;
      try {
        await run(paths.ffmpeg, buildRemuxArgs(filePath, tmpOut, mode), { timeoutMs: mode.kind === 'copy' ? COPY_TIMEOUT_MS : TRANSCODE_TIMEOUT_MS });
        const st = await stat(tmpOut);
        if (!st.isFile() || st.size === 0) throw new Error('ffmpeg produced an empty file');
        await rename(tmpOut, cacheOut);
        return cacheOut;
      } catch (error) {
        options.onError?.(error, filePath);
        await rm(tmpOut, { force: true }).catch(() => undefined);
      }
    }
    return undefined;
  };

  return {
    available: () => options.ffmpeg() !== undefined,
    async remux(filePath) {
      const paths = options.ffmpeg();
      if (!paths) return undefined;
      let size: number;
      let mtimeMs: number;
      try {
        const st = await stat(filePath);
        if (!st.isFile()) return undefined;
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        return undefined;
      }
      const cacheOut = join(cacheDir, `${compatCacheKey(filePath, size, mtimeMs)}.mp4`);
      try {
        const cached = await stat(cacheOut);
        if (cached.isFile() && cached.size > 0) return cacheOut;
      } catch {
        // not cached yet
      }
      const pending = jobs.get(cacheOut);
      if (pending) return pending;
      const job = produce(paths, filePath, cacheOut)
        .catch((error: unknown) => {
          options.onError?.(error, filePath);
          return undefined;
        })
        .finally(() => jobs.delete(cacheOut));
      jobs.set(cacheOut, job);
      return job;
    },
  };
}
