import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRemuxArgs,
  compatCacheKey,
  createCompatRemuxer,
  hasCompatParam,
  isAppleWebKitUserAgent,
  remuxPlan,
  wantsCompatRemux,
  type ProcessRunner,
} from './compat-remux';

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const WKWEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const CHROMIUM = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/130.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

const PATHS = { ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' };

function probeJson(videoCodec: string): string {
  return JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: videoCodec }, { index: 1, codec_type: 'audio', codec_name: 'opus' }], format: { duration: '2.0' } });
}

interface FakeRun {
  run: ProcessRunner;
  calls: { command: string; args: readonly string[] }[];
  ffmpegCalls: () => (readonly string[])[];
}

/** Fake runner: ffprobe answers `probe`, ffmpeg writes `MP4:<mode>` to its output unless `fail(args)` says otherwise. */
function fakeRun(opts: { probe?: string | Error; fail?: (args: readonly string[]) => boolean; delayMs?: number; empty?: boolean } = {}): FakeRun {
  const calls: { command: string; args: readonly string[] }[] = [];
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === PATHS.ffprobe) {
      if (opts.probe instanceof Error) throw opts.probe;
      return { stdout: opts.probe ?? probeJson('hevc'), stderr: '' };
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const out = args[args.length - 1] ?? '';
    if (opts.fail?.(args)) {
      await writeFile(out, 'partial');
      throw new Error(`${command} exited with 1: boom`);
    }
    await writeFile(out, opts.empty ? '' : `MP4:${args.includes('libx264') ? 'x264' : args.includes('hvc1') ? 'hvc1' : 'copy'}`);
    return { stdout: '', stderr: '' };
  };
  return { run, calls, ffmpegCalls: () => calls.filter((c) => c.command === PATHS.ffmpeg).map((c) => c.args) };
}

describe('request detection', () => {
  it('recognises Safari / iOS WebKit but not Chromium-based or Gecko browsers', () => {
    expect(isAppleWebKitUserAgent(SAFARI_MAC)).toBe(true);
    expect(isAppleWebKitUserAgent(SAFARI_IOS)).toBe(true);
    expect(isAppleWebKitUserAgent(WKWEBVIEW)).toBe(true);
    expect(isAppleWebKitUserAgent(CHROME)).toBe(false);
    expect(isAppleWebKitUserAgent(EDGE)).toBe(false);
    expect(isAppleWebKitUserAgent(CHROMIUM)).toBe(false);
    expect(isAppleWebKitUserAgent(FIREFOX)).toBe(false);
    expect(isAppleWebKitUserAgent(undefined)).toBe(false);
    expect(isAppleWebKitUserAgent('')).toBe(false);
  });

  it('parses the compat query parameter', () => {
    expect(hasCompatParam('http://h/media/ep?compat=1')).toBe(true);
    expect(hasCompatParam('/media/ep?x=2&compat=1')).toBe(true);
    expect(hasCompatParam('/media/ep?compat=0')).toBe(false);
    expect(hasCompatParam('/media/ep')).toBe(false);
  });

  it('wants a remux for ?compat=1 or Apple WebKit + mkv/avi/ts only', () => {
    expect(wantsCompatRemux('/v/a.mkv', '/media/ep', SAFARI_IOS)).toBe(true);
    expect(wantsCompatRemux('/v/a.MKV', '/media/ep', SAFARI_MAC)).toBe(true);
    expect(wantsCompatRemux('/v/a.avi', '/media/ep', SAFARI_MAC)).toBe(true);
    expect(wantsCompatRemux('/v/a.ts', '/media/ep', WKWEBVIEW)).toBe(true);
    expect(wantsCompatRemux('/v/a.mp4', '/media/ep', SAFARI_IOS)).toBe(false);
    expect(wantsCompatRemux('/v/a.webm', '/media/ep', SAFARI_IOS)).toBe(false);
    expect(wantsCompatRemux('/v/a.mkv', '/media/ep', CHROME)).toBe(false);
    expect(wantsCompatRemux('/v/a.mkv', '/media/ep', undefined)).toBe(false);
    expect(wantsCompatRemux('/v/a.mp4', '/media/ep?compat=1', CHROME)).toBe(true);
    expect(wantsCompatRemux('/v/a.mkv', 'http://127.0.0.1:7865/media/ep?compat=1', undefined)).toBe(true);
  });
});

describe('ffmpeg arguments and plan', () => {
  it('builds copy (+hvc1) and libx264 argument lists', () => {
    expect(buildRemuxArgs('in.mkv', 'out.mp4', { kind: 'copy', hvc1: true })).toEqual([
      '-y', '-v', 'error', '-i', 'in.mkv', '-map', '0:v:0', '-map', '0:a:0?', '-map_chapters', '-1', '-sn', '-dn', '-c:v', 'copy', '-tag:v', 'hvc1',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', 'out.mp4',
    ]);
    expect(buildRemuxArgs('in.mkv', 'out.mp4', { kind: 'copy', hvc1: false })).not.toContain('-tag:v');
    expect(buildRemuxArgs('in.mkv', 'out.mp4', { kind: 'transcode' })).toEqual([
      '-y', '-v', 'error', '-i', 'in.mkv', '-map', '0:v:0', '-map', '0:a:0?', '-map_chapters', '-1', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', 'out.mp4',
    ]);
  });

  it('copies H.264/HEVC, transcodes everything else, and probes harder when unknown', () => {
    expect(remuxPlan('hevc')).toEqual([{ kind: 'copy', hvc1: true }, { kind: 'transcode' }]);
    expect(remuxPlan('h264')).toEqual([{ kind: 'copy', hvc1: false }, { kind: 'transcode' }]);
    expect(remuxPlan('vp9')).toEqual([{ kind: 'transcode' }]);
    expect(remuxPlan('av1')).toEqual([{ kind: 'transcode' }]);
    expect(remuxPlan(undefined)).toEqual([{ kind: 'copy', hvc1: true }, { kind: 'copy', hvc1: false }, { kind: 'transcode' }]);
  });

  it('derives a cache key from path, size and mtime', () => {
    const a = compatCacheKey('/v/a.mkv', 100, 1);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(compatCacheKey('/v/a.mkv', 100, 1)).toBe(a);
    expect(compatCacheKey('/v/a.mkv', 101, 1)).not.toBe(a);
    expect(compatCacheKey('/v/a.mkv', 100, 2)).not.toBe(a);
    expect(compatCacheKey('/v/b.mkv', 100, 1)).not.toBe(a);
  });
});

describe('createCompatRemuxer', () => {
  let dir: string;
  let cacheDir: string;
  let source: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kotori-compat-'));
    cacheDir = join(dir, 'cache');
    source = join(dir, 'ep01.mkv');
    await writeFile(source, 'matroska-bytes');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is unavailable without ffmpeg and never spawns', async () => {
    const fake = fakeRun();
    const remuxer = createCompatRemuxer({ ffmpeg: () => undefined, cacheDir, run: fake.run });
    expect(remuxer.available()).toBe(false);
    expect(await remuxer.remux(source)).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it('returns undefined for a missing source', async () => {
    const fake = fakeRun();
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run });
    expect(await remuxer.remux(join(dir, 'missing.mkv'))).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it('remuxes HEVC with -c:v copy -tag:v hvc1 into the cache dir and reuses the cached file', async () => {
    const fake = fakeRun({ probe: probeJson('hevc') });
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run });
    expect(remuxer.available()).toBe(true);
    const out = await remuxer.remux(source);
    expect(out?.startsWith(cacheDir)).toBe(true);
    expect(basename(out!)).toMatch(/^[0-9a-f]{32}\.mp4$/);
    expect(await readFile(out!, 'utf8')).toBe('MP4:hvc1');
    const [args] = fake.ffmpegCalls();
    expect(args?.slice(0, 5)).toEqual(['-y', '-v', 'error', '-i', source]);
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-tag:v', 'hvc1', '-c:a', 'aac']));
    // Wrote to a temp file first, then atomically renamed.
    expect(args?.[args.length - 1]).toMatch(/\.tmp\.mp4$/);
    expect(await readdir(cacheDir)).toEqual([out!.slice(cacheDir.length + 1)]);

    expect(await remuxer.remux(source)).toBe(out);
    expect(fake.ffmpegCalls()).toHaveLength(1);
    expect(fake.calls.filter((c) => c.command === PATHS.ffprobe)).toHaveLength(1);
  });

  it('re-remuxes when the source changes (size / mtime)', async () => {
    const fake = fakeRun();
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run });
    const first = await remuxer.remux(source);
    await utimes(source, new Date(), new Date(Date.now() + 60_000));
    const second = await remuxer.remux(source);
    expect(second).not.toBe(first);
    expect(fake.ffmpegCalls()).toHaveLength(2);
  });

  it('deduplicates concurrent remuxes of the same file', async () => {
    const fake = fakeRun({ delayMs: 30 });
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run });
    const results = await Promise.all([remuxer.remux(source), remuxer.remux(source), remuxer.remux(source)]);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBeDefined();
    expect(fake.ffmpegCalls()).toHaveLength(1);
  });

  it('falls back to libx264 when stream copy fails and cleans up the partial file', async () => {
    const onError = vi.fn();
    const fake = fakeRun({ probe: probeJson('hevc'), fail: (args) => args.includes('copy') });
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run, onError });
    const out = await remuxer.remux(source);
    expect(await readFile(out!, 'utf8')).toBe('MP4:x264');
    expect(fake.ffmpegCalls().map((a) => a.includes('libx264'))).toEqual([false, true]);
    expect(fake.ffmpegCalls()[1]).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']));
    expect(fake.ffmpegCalls()[1]).not.toContain('hvc1');
    expect(onError).toHaveBeenCalledTimes(1);
    expect((await readdir(cacheDir)).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('transcodes non-H.264/HEVC video (e.g. VP9) directly', async () => {
    const fake = fakeRun({ probe: probeJson('vp9') });
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run });
    expect(await readFile((await remuxer.remux(source))!, 'utf8')).toBe('MP4:x264');
    expect(fake.ffmpegCalls()).toHaveLength(1);
  });

  it('copies H.264 without the hvc1 tag', async () => {
    const fake = fakeRun({ probe: probeJson('h264') });
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run });
    expect(await readFile((await remuxer.remux(source))!, 'utf8')).toBe('MP4:copy');
  });

  it('tries hvc1 copy, plain copy, then transcode when ffprobe fails', async () => {
    const fake = fakeRun({ probe: new Error('ffprobe exited with 1'), fail: (args) => args.includes('hvc1') });
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: fake.run });
    expect(await readFile((await remuxer.remux(source))!, 'utf8')).toBe('MP4:copy');
    expect(fake.ffmpegCalls()).toHaveLength(2);
  });

  it('returns undefined (caller serves the original) when every attempt fails or output is empty', async () => {
    const onError = vi.fn();
    const failing = fakeRun({ fail: () => true });
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: failing.run, onError });
    expect(await remuxer.remux(source)).toBeUndefined();
    expect(failing.ffmpegCalls()).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(await readdir(cacheDir)).toEqual([]);

    const empty = fakeRun({ empty: true });
    const remuxer2 = createCompatRemuxer({ ffmpeg: () => PATHS, cacheDir, run: empty.run });
    expect(await remuxer2.remux(source)).toBeUndefined();
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('defaults the cache dir to <tmpdir>/kotori-media-cache', async () => {
    const fake = fakeRun();
    const remuxer = createCompatRemuxer({ ffmpeg: () => PATHS, run: fake.run });
    const out = await remuxer.remux(source);
    try {
      expect(out?.startsWith(join(tmpdir(), 'kotori-media-cache'))).toBe(true);
    } finally {
      if (out) await rm(out, { force: true });
    }
  });
});
