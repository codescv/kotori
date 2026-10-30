import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KotoriError } from '@kotori/core';
import {
  canRunBinary,
  extractSubtitleStream,
  findFfmpeg,
  interpretProbe,
  isFatalSpawnError,
  probeStreams,
  runProcess,
  TEXT_SUBTITLE_CODECS,
} from './ffmpeg';

const FIXTURE = fileURLToPath(new URL('../../test-fixtures/media/ffprobe-mkv.json', import.meta.url));

describe('interpretProbe', () => {
  it('interprets a typical anime MKV probe', () => {
    const result = interpretProbe(readFileSync(FIXTURE, 'utf8'));
    expect(result).toEqual({
      durationMs: 1_420_512,
      // The attached cover picture (mjpeg) is not the video stream.
      videoCodec: 'hevc',
      audioCodecs: ['aac', 'ac3'],
      subtitles: [
        { index: 4, codec: 'ass', format: 'ass', language: 'ja', title: '日本語', isDefault: true },
        { index: 5, codec: 'subrip', format: 'srt', language: 'en', isDefault: false },
        // PGS (bitmap) is skipped; `und` yields no language.
        { index: 7, codec: 'mov_text', format: 'srt', isDefault: false },
      ],
      warnings: [
        'Video codec hevc may not play in the browser (H.264/VP9/AV1 supported).',
        'Audio codec ac3 may not play in the browser (AAC/Opus/Vorbis/FLAC supported).',
      ],
    });
    expect(result.subtitles[2]).not.toHaveProperty('language');
    expect(result.subtitles[2]).not.toHaveProperty('title');
  });

  it('returns empty collections and omits optional fields for an empty probe', () => {
    const result = interpretProbe('{}');
    expect(result).toEqual({ audioCodecs: [], subtitles: [], warnings: [] });
    expect(result).not.toHaveProperty('durationMs');
    expect(result).not.toHaveProperty('videoCodec');
  });

  it('handles browser-friendly codecs, unknown audio codecs and odd subtitle streams', () => {
    const json = JSON.stringify({
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'opus' },
        { index: 2, codec_type: 'audio' },
        { codec_type: 'subtitle', codec_name: 'ass' }, // no index → skipped
        { index: 4, codec_type: 'subtitle', codec_name: 'webvtt', tags: { language: 'JPN' } },
        { index: 5, codec_type: 'subtitle', codec_name: 'ssa', tags: { language: 'fre' }, disposition: { default: 1 } },
        { index: 6, codec_type: 'subtitle', codec_name: 'dvd_subtitle' },
      ],
      format: { duration: 'N/A' },
    });
    const result = interpretProbe(json);
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodecs).toEqual(['opus', 'unknown']);
    expect(result.warnings).toEqual(['Audio codec unknown may not play in the browser (AAC/Opus/Vorbis/FLAC supported).']);
    expect(result).not.toHaveProperty('durationMs');
    expect(result.subtitles).toEqual([
      { index: 4, codec: 'webvtt', format: 'vtt', language: 'ja', isDefault: false },
      { index: 5, codec: 'ssa', format: 'ass', language: 'fre', isDefault: true },
    ]);
  });

  it('throws on invalid JSON', () => {
    expect(() => interpretProbe('not json')).toThrow(SyntaxError);
  });

  it('maps text subtitle codecs to file formats', () => {
    expect(TEXT_SUBTITLE_CODECS).toMatchObject({ ass: 'ass', ssa: 'ass', subrip: 'srt', webvtt: 'vtt', mov_text: 'srt' });
    expect(TEXT_SUBTITLE_CODECS['hdmv_pgs_subtitle']).toBeUndefined();
  });
});

describe('with fake binaries', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kotori-ffmpeg-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write an executable (or not) shell stub at `dir/sub/name`. */
  async function stub(sub: string, name: string, body: string, mode = 0o755): Promise<string> {
    const path = join(dir, sub, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, mode);
    return path;
  }

  describe('findFfmpeg', () => {
    it('finds ffmpeg + ffprobe on PATH', async () => {
      await stub('bin', 'ffmpeg', 'exit 0');
      await stub('bin', 'ffprobe', 'exit 0');
      await expect(findFfmpeg({ PATH: [join(dir, 'empty'), join(dir, 'bin')].join(delimiter) })).resolves.toEqual({
        ffmpeg: join(dir, 'bin', 'ffmpeg'),
        ffprobe: join(dir, 'bin', 'ffprobe'),
      });
    });

    it('prefers $KOTORI_FFMPEG_DIR over PATH', async () => {
      await stub('bin', 'ffmpeg', 'exit 0');
      await stub('bin', 'ffprobe', 'exit 0');
      await stub('custom', 'ffmpeg', 'exit 0');
      await stub('custom', 'ffprobe', 'exit 0');
      const found = await findFfmpeg({ KOTORI_FFMPEG_DIR: join(dir, 'custom'), PATH: join(dir, 'bin') });
      expect(found?.ffmpeg).toBe(join(dir, 'custom', 'ffmpeg'));
      expect(found?.ffprobe).toBe(join(dir, 'custom', 'ffprobe'));
    });

    it('skips directories with only one binary or non-executable files', async () => {
      await stub('half', 'ffmpeg', 'exit 0'); // no ffprobe here
      await stub('noexec', 'ffmpeg', 'exit 0', 0o644);
      await stub('noexec', 'ffprobe', 'exit 0', 0o644);
      await stub('good', 'ffmpeg', 'exit 0');
      await stub('good', 'ffprobe', 'exit 0');
      const PATH = ['half', 'noexec', 'good'].map((d) => join(dir, d)).join(delimiter);
      expect((await findFfmpeg({ PATH }))?.ffmpeg).toBe(join(dir, 'good', 'ffmpeg'));
    });

    it('only falls back to the well-known system locations when PATH has nothing', async () => {
      await stub('half', 'ffprobe', 'exit 0');
      const found = await findFfmpeg({ PATH: join(dir, 'half') });
      // The host may or may not have a system ffmpeg; either way nothing under our temp dir qualifies.
      if (found) expect(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin']).toContain(dirname(found.ffmpeg));
      else expect(found).toBeUndefined();
    });

    it('skips a directory whose binary fails verify (e.g. macOS EBADARCH / Unknown system error -86) and picks the next working one', async () => {
      const x86Dir = join(dir, 'usr-local-x86');
      const armDir = join(dir, 'opt-homebrew-arm');
      const checked: string[] = [];
      const verify = vi.fn(async (binPath: string) => {
        checked.push(binPath);
        if (binPath.startsWith(x86Dir)) {
          throw Object.assign(new Error('spawn Unknown system error -86'), { code: 'EBADARCH', errno: -86 });
        }
        return binPath.startsWith(armDir);
      });

      const found = await findFfmpeg({ PATH: [x86Dir, x86Dir, armDir].join(delimiter) }, verify);
      expect(found).toEqual({
        ffmpeg: join(armDir, 'ffmpeg'),
        ffprobe: join(armDir, 'ffprobe'),
      });
      // Duplicate x86Dir in PATH is deduplicated so x86 ffmpeg is only probed once.
      expect(checked.filter((p) => p === join(x86Dir, 'ffmpeg'))).toHaveLength(1);

      await expect(findFfmpeg({ PATH: x86Dir }, async () => false)).resolves.toBeUndefined();
    });

    it('canRunBinary and default findFfmpeg skip executable files that fail to run', async () => {
      await stub('broken', 'ffmpeg', 'exit 0');
      const brokenProbe = join(dir, 'broken', 'ffprobe');
      await mkdir(dirname(brokenProbe), { recursive: true });
      await writeFile(brokenProbe, '#!/nonexistent/rosetta/sh\nexit 0\n');
      await chmod(brokenProbe, 0o755);

      await stub('working', 'ffmpeg', 'exit 0');
      await stub('working', 'ffprobe', 'exit 0');

      expect(await canRunBinary(brokenProbe)).toBe(false);
      expect(await canRunBinary(join(dir, 'working', 'ffprobe'))).toBe(true);

      const found = await findFfmpeg({ PATH: [join(dir, 'broken'), join(dir, 'working')].join(delimiter) });
      expect(found).toEqual({
        ffmpeg: join(dir, 'working', 'ffmpeg'),
        ffprobe: join(dir, 'working', 'ffprobe'),
      });
    });
  });

  describe('isFatalSpawnError', () => {
    it('detects EBADARCH / Unknown system error -86 and unrecoverable spawn errors, but not exit-code or timeout errors', () => {
      const ebadarch = Object.assign(new Error('spawn /usr/local/bin/ffprobe Unknown system error -86'), {
        code: 'Unknown system error -86',
        errno: -86,
        syscall: 'spawn /usr/local/bin/ffprobe',
      });
      expect(isFatalSpawnError(ebadarch)).toBe(true);
      expect(isFatalSpawnError(new KotoriError('io', `/usr/local/bin/ffprobe: ${ebadarch.message}`, { cause: ebadarch }))).toBe(true);
      expect(isFatalSpawnError(new Error('spawn Unknown system error -86'))).toBe(true);
      expect(isFatalSpawnError(Object.assign(new Error('bad cpu'), { code: 'EBADARCH' }))).toBe(true);
      expect(isFatalSpawnError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true);
      expect(isFatalSpawnError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(true);
      expect(isFatalSpawnError(Object.assign(new Error('perm'), { code: 'EPERM' }))).toBe(true);
      expect(isFatalSpawnError(Object.assign(new Error('exec'), { code: 'ENOEXEC' }))).toBe(true);

      expect(isFatalSpawnError(new KotoriError('io', '/usr/bin/ffprobe exited with 1: /videos/ENOENT.mp4: Invalid data'))).toBe(false);
      expect(isFatalSpawnError(new KotoriError('io', '/usr/bin/ffprobe timed out'))).toBe(false);
      expect(isFatalSpawnError(undefined)).toBe(false);
    });
  });

  describe('runProcess', () => {
    it('collects stdout and stderr', async () => {
      const cmd = await stub('bin', 'echoer', 'echo "out $1"; echo "err $2" >&2');
      await expect(runProcess(cmd, ['a', 'b'])).resolves.toEqual({ stdout: 'out a\n', stderr: 'err b\n' });
    });

    it('rejects with an io error carrying the exit code and stderr tail', async () => {
      const cmd = await stub('bin', 'fail', 'echo "boom: invalid data" >&2; exit 3');
      const err = await runProcess(cmd, []).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'KotoriError', code: 'io' });
      expect((err as Error).message).toContain('exited with 3');
      expect((err as Error).message).toContain('boom: invalid data');
    });

    it('rejects with an io error when the binary does not exist', async () => {
      await expect(runProcess(join(dir, 'missing'), [])).rejects.toMatchObject({ code: 'io' });
    });

    it('kills and rejects on timeout', async () => {
      const cmd = await stub('bin', 'slow', 'exec sleep 10');
      const started = Date.now();
      await expect(runProcess(cmd, [], { timeoutMs: 150 })).rejects.toMatchObject({ code: 'io', message: expect.stringContaining('timed out') });
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  it('probeStreams runs ffprobe with JSON output and interprets it', async () => {
    const argsFile = join(dir, 'probe-args.txt');
    const ffprobe = await stub('bin', 'ffprobe', `printf '%s\\n' "$@" > '${argsFile}'\ncat '${FIXTURE}'`);
    const result = await probeStreams({ ffmpeg: '/nonexistent/ffmpeg', ffprobe }, '/videos/ep 01.mkv');
    expect(result.videoCodec).toBe('hevc');
    expect(result.subtitles).toHaveLength(3);
    const args = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
    expect(args).toEqual(['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', '/videos/ep 01.mkv']);
  });

  it.each([
    ['out.ass', 'ass'],
    ['out.SRT', 'srt'],
    ['out.vtt', 'webvtt'],
    ['out.ssa', 'ass'],
  ])('extractSubtitleStream → %s uses -c:s %s', async (outName, codec) => {
    const argsFile = join(dir, 'ffmpeg-args.txt');
    const ffmpeg = await stub('bin', 'ffmpeg', `printf '%s\\n' "$@" > '${argsFile}'`);
    const outPath = join(dir, outName);
    await extractSubtitleStream({ ffmpeg, ffprobe: '/nonexistent/ffprobe' }, '/videos/ep.mkv', 4, outPath);
    const args = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
    expect(args).toEqual(['-y', '-v', 'error', '-i', '/videos/ep.mkv', '-map', '0:4', '-c:s', codec, outPath]);
  });

  it('extractSubtitleStream propagates ffmpeg failures', async () => {
    const ffmpeg = await stub('bin', 'ffmpeg', 'echo "Stream map 0:9 matches no streams" >&2; exit 1');
    await expect(extractSubtitleStream({ ffmpeg, ffprobe: '' }, '/v.mkv', 9, join(dir, 'o.ass'))).rejects.toMatchObject({
      code: 'io',
      message: expect.stringContaining('matches no streams'),
    });
  });
});
