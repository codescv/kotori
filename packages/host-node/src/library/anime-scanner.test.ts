import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchSidecars, scanAnimeFolder, SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from './anime-scanner';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotori-anime-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Create `rel` (forward-slash path) under `root` with `content`, making parent dirs. */
async function touch(rel: string, content: string | Uint8Array = 'x'): Promise<string> {
  const full = join(root, ...rel.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  return full;
}

describe('extension tables', () => {
  it('maps video and subtitle extensions', () => {
    expect(VIDEO_EXTENSIONS['.m4v']).toBe('mp4');
    expect(VIDEO_EXTENSIONS['.mkv']).toBe('mkv');
    expect(VIDEO_EXTENSIONS['.avi']).toBe('other');
    expect(SUBTITLE_EXTENSIONS['.ssa']).toBe('ass');
    expect(SUBTITLE_EXTENSIONS['.vtt']).toBe('vtt');
  });
});

describe('scanAnimeFolder (directory)', () => {
  async function buildSeries(): Promise<string> {
    const dir = join(root, 'Show');
    await touch('Show/[Group] Show - 02 (1080p).mkv', '22');
    await touch('Show/[Group] Show - 01 (1080p).mkv', '1111');
    await touch('Show/[Group] Show - 01 (1080p).ja.ass');
    await touch('Show/[Group] Show - 01 (1080p).srt');
    await touch('Show/[Group] Show - 01 (1080p).en.srt');
    await touch('Show/[Group] Show - 02 (1080p).Signs.ass');
    await touch('Show/Season 2/[Group] Show S02E03 (1080p).mp4');
    await touch('Show/Season 2/[Group] Show S02E03 (1080p).ja.srt');
    await touch('Show/Season 2/cover.jpg'); // not in the root → ignored
    await touch('Show/cover.jpg');
    await touch('Show/notes.txt');
    await touch('Show/.hidden.mkv');
    await touch('Show/@eaDir/[Group] Show - 09 (1080p).mkv');
    return dir;
  }

  it('groups videos into ordered episodes with metadata', async () => {
    const dir = await buildSeries();
    const series = await scanAnimeFolder(dir);
    expect(series.sourcePath).toBe(dir);
    expect(series.title).toBe('Show');
    expect(series.coverPath).toBe(join(dir, 'cover.jpg'));
    expect(series.episodes.map((e) => e.fileName)).toEqual([
      '[Group] Show - 01 (1080p).mkv',
      '[Group] Show - 02 (1080p).mkv',
      '[Group] Show S02E03 (1080p).mp4',
    ]);
    const [ep1, ep2, ep3] = series.episodes;
    expect(ep1).toMatchObject({
      filePath: join(dir, '[Group] Show - 01 (1080p).mkv'),
      container: 'mkv',
      sizeBytes: 4,
      title: '第1話',
      parsedName: { title: 'Show', episode: 1, releaseGroup: 'Group', resolution: '1080p' },
    });
    expect(ep2?.sizeBytes).toBe(2);
    expect(ep3).toMatchObject({ container: 'mp4', title: '第3話', parsedName: { season: 2, episode: 3 } });
  });

  it('attaches sidecars by basename prefix, Japanese first, with labels', async () => {
    const dir = await buildSeries();
    const [ep1, ep2, ep3] = (await scanAnimeFolder(dir)).episodes;
    expect(ep1?.sidecars).toEqual([
      {
        filePath: join(dir, '[Group] Show - 01 (1080p).ja.ass'),
        fileName: '[Group] Show - 01 (1080p).ja.ass',
        format: 'ass',
        language: 'ja',
        label: 'JA (ass)',
      },
      { filePath: join(dir, '[Group] Show - 01 (1080p).en.srt'), fileName: '[Group] Show - 01 (1080p).en.srt', format: 'srt', language: 'en', label: 'EN (srt)' },
      { filePath: join(dir, '[Group] Show - 01 (1080p).srt'), fileName: '[Group] Show - 01 (1080p).srt', format: 'srt', label: 'External (srt)' },
    ]);
    expect(ep1?.sidecars[2]).not.toHaveProperty('language');
    expect(ep2?.sidecars).toEqual([
      expect.objectContaining({ fileName: '[Group] Show - 02 (1080p).Signs.ass', format: 'ass', label: 'Signs (ass)' }),
    ]);
    expect(ep3?.sidecars).toEqual([expect.objectContaining({ fileName: '[Group] Show S02E03 (1080p).ja.srt', language: 'ja', format: 'srt' })]);
  });

  it('skips dot-files, @-folders and non-media files', async () => {
    const dir = await buildSeries();
    const names = (await scanAnimeFolder(dir)).episodes.map((e) => e.fileName);
    expect(names).not.toContain('.hidden.mkv');
    expect(names.some((n) => n.includes('09'))).toBe(false);
  });

  it('respects maxDepth', async () => {
    const dir = await buildSeries();
    const shallow = await scanAnimeFolder(dir, { maxDepth: 0 });
    expect(shallow.episodes).toHaveLength(2);
    await touch('Show/a/b/c/d/[Group] Show - 05 (1080p).mkv');
    expect((await scanAnimeFolder(dir)).episodes.map((e) => e.parsedName.episode)).not.toContain(5);
    expect((await scanAnimeFolder(dir, { maxDepth: 4 })).episodes.map((e) => e.parsedName.episode)).toContain(5);
  });

  it('falls back to episode-number matching for differently named subtitles', async () => {
    const dir = join(root, 'S');
    await touch('S/[Group] Show - 01 (1080p).mkv');
    await touch('S/[Group] Show - 02 (1080p).mkv');
    await touch('S/Show 02.ja.srt');
    await touch('S/Show 07.srt'); // no owner → dropped
    const [ep1, ep2] = (await scanAnimeFolder(dir)).episodes;
    expect(ep1?.sidecars).toEqual([]);
    expect(ep2?.sidecars).toEqual([
      { filePath: join(dir, 'Show 02.ja.srt'), fileName: 'Show 02.ja.srt', format: 'srt', language: 'ja', label: 'JA (srt)' },
    ]);
  });

  it('gives a lone video every subtitle in its folder', async () => {
    const dir = join(root, 'Movie');
    await touch('Movie/Movie (2020).mkv');
    await touch('Movie/subs.ja.ass');
    const series = await scanAnimeFolder(dir);
    expect(series.episodes).toHaveLength(1);
    expect(series.episodes[0]?.sidecars.map((s) => s.fileName)).toEqual(['subs.ja.ass']);
  });

  it('uses the folder name as title when no episode title parses, and omits coverPath', async () => {
    const dir = join(root, 'Empty Folder');
    await mkdir(dir);
    const series = await scanAnimeFolder(dir);
    expect(series).toEqual({ sourcePath: dir, title: 'Empty Folder', episodes: [] });
    expect(series).not.toHaveProperty('coverPath');
  });

  it('recognises folder/poster cover names case-insensitively', async () => {
    const dir = join(root, 'C');
    await touch('C/Poster.PNG');
    expect((await scanAnimeFolder(dir)).coverPath).toBe(join(dir, 'Poster.PNG'));
  });

  it('rejects a missing path', async () => {
    await expect(scanAnimeFolder(join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('parses NogiKouji variety recordings and never picks a bare 4-digit year over folder fallback', async () => {
    const dir = join(root, 'NogiKouji');
    await touch('NogiKouji/2026-08-23_【公式】「乃木坂工事中」# 578「初耳46 前編」2026.08.23 OA_[cEE5gee6cx4].mp4', 'video1');
    await touch('NogiKouji/2026-08-30_【公式】「乃木坂工事中」# 579「初耳46 後編」2026.08.30 OA_[dFF6hff7dy5].mp4', 'video2');
    const scanned = await scanAnimeFolder(dir);
    expect(scanned.title).toBe('乃木坂工事中');
    expect(scanned.episodes.map((e) => e.parsedName.episode)).toEqual([578, 579]);

    const yearOnlyDir = join(root, 'MyVarietyFolder');
    await touch('MyVarietyFolder/2026.mp4', 'v');
    const fallbackScanned = await scanAnimeFolder(yearOnlyDir);
    expect(fallbackScanned.title).toBe('MyVarietyFolder');
  });
});

describe('scanAnimeFolder (single file)', () => {
  it('imports only the chosen video and its prefixed sidecars', async () => {
    const video = await touch('dl/[Group] Show - 01 (1080p).mkv', 'abc');
    await touch('dl/[Group] Show - 01 (1080p).ja.ass');
    await touch('dl/[Group] Show - 02 (1080p).mkv');
    await touch('dl/[Group] Show - 02 (1080p).ja.ass');
    await touch('dl/Other Show 01.srt');
    await touch('dl/cover.jpg');
    const series = await scanAnimeFolder(video);
    expect(series.sourcePath).toBe(video);
    expect(series.title).toBe('Show');
    expect(series.episodes).toHaveLength(1);
    expect(series.episodes[0]).toMatchObject({ fileName: '[Group] Show - 01 (1080p).mkv', sizeBytes: 3 });
    expect(series.episodes[0]?.sidecars.map((s) => s.fileName)).toEqual(['[Group] Show - 01 (1080p).ja.ass']);
    // Only the video and its sidecars are considered, so a sibling cover is not picked up.
    expect(series).not.toHaveProperty('coverPath');
  });

  it('falls back to the file stem as title when nothing parses', async () => {
    const video = await touch('dl/[]].mp4');
    const series = await scanAnimeFolder(video);
    expect(series.episodes).toHaveLength(1);
    expect(typeof series.title).toBe('string');
    expect(series.title.length).toBeGreaterThan(0);
  });
});

describe('matchSidecars', () => {
  const entry = (dir: string, name: string): { path: string; name: string; dir: string; size: number } => ({ path: `${dir}/${name}`, name, dir, size: 0 });

  it('prefers the longest prefixing video stem', () => {
    const v1 = entry('/d', 'Show - 1.mkv');
    const v10 = entry('/d', 'Show - 10.mkv');
    const sub = entry('/d', 'Show - 10.ja.ass');
    const out = matchSidecars([v1, v10], [sub]);
    expect(out.get(v1.path)).toEqual([]);
    expect(out.get(v10.path)?.map((s) => s.fileName)).toEqual(['Show - 10.ja.ass']);
  });

  it('only matches within the same directory and ignores unknown formats', () => {
    const v = entry('/a', 'Show - 01.mkv');
    const elsewhere = entry('/b', 'Show - 01.ja.ass');
    const unknown = entry('/a', 'Show - 01.sup');
    const out = matchSidecars([v], [elsewhere, unknown]);
    expect(out.get(v.path)).toEqual([]);
  });

  it('does not guess when several videos share an episode number', () => {
    const a = entry('/d', 'A - 01.mkv');
    const b = entry('/d', 'B - 01.mkv');
    const out = matchSidecars([a, b], [entry('/d', 'C - 01.srt')]);
    expect(out.get(a.path)).toEqual([]);
    expect(out.get(b.path)).toEqual([]);
  });
});
