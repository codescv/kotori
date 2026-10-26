import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAnimeFolder, stemMatches } from './anime-scanner';

describe('sidecar stem boundaries', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kotori-boundary-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stemMatches requires a separator after the video stem', () => {
    expect(stemMatches('Show - 1', 'Show - 1')).toBe(true);
    expect(stemMatches('Show - 1.ja', 'Show - 1')).toBe(true);
    expect(stemMatches('Show - 1 [CC]', 'Show - 1')).toBe(true);
    expect(stemMatches('Show - 1_en', 'Show - 1')).toBe(true);
    expect(stemMatches('Show - 10.ja', 'Show - 1')).toBe(false);
    expect(stemMatches('Other', 'Show')).toBe(false);
  });

  it('does not attach "Show - 10" subtitles to "Show - 1"', async () => {
    const show = join(dir, 'Show');
    await mkdir(show);
    await writeFile(join(show, 'Show - 1.mkv'), 'v');
    await writeFile(join(show, 'Show - 1.ja.ass'), 's');
    await writeFile(join(show, 'Show - 10.ja.ass'), 's');
    const scan = await scanAnimeFolder(show);
    expect(scan.episodes).toHaveLength(1);
    expect(scan.episodes[0]?.sidecars.map((s) => s.fileName)).toEqual(['Show - 1.ja.ass']);
  });

  it('a lone video still adopts an episode-less subtitle', async () => {
    const movie = join(dir, 'Movie');
    await mkdir(movie);
    await writeFile(join(movie, 'Movie (2020).mkv'), 'v');
    await writeFile(join(movie, 'japanese.srt'), 's');
    const scan = await scanAnimeFolder(movie);
    expect(scan.episodes[0]?.sidecars.map((s) => s.fileName)).toEqual(['japanese.srt']);
  });
});
