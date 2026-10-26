import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedEpisodeName } from '@kotori/core';
import { openDatabase, type Database } from '../sqlite';
import { createRepositories, type EpisodeRecord, type Repositories } from './index';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

type Backend = 'memory' | 'file';

function open(backend: Backend): { db: Database; repos: Repositories } {
  let path = ':memory:';
  if (backend === 'file') {
    const dir = mkdtempSync(join(tmpdir(), 'kotori-episodes-test-'));
    tmpDirs.push(dir);
    path = join(dir, 'kotori.db');
  }
  const db = openDatabase(path);
  dbs.push(db);
  const repos = createRepositories(db);
  repos.series.upsert({ id: 's1', title: 'Show', sourcePath: '/anime/Show', addedAt: 1 });
  return { db, repos };
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const parsed: ParsedEpisodeName = {
  raw: '[Group] Show - 01v2 (1080p) [ABCD1234].mkv',
  title: 'Show',
  episode: 1,
  episodeRange: [1, 1],
  version: 2,
  releaseGroup: 'Group',
  resolution: '1080p',
  crc32: 'ABCD1234',
  isBatch: false,
};

function episode(over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: 'e1',
    seriesId: 's1',
    title: 'Episode 1',
    fileName: 'Show - 01.mkv',
    filePath: '/anime/Show/Show - 01.mkv',
    container: 'mkv',
    sizeBytes: 1_234_567_890_123,
    parsedName: parsed,
    sortIndex: 0,
    ...over,
  };
}

describe.each<Backend>(['memory', 'file'])('EpisodeRepository (%s db)', (backend) => {
  it('round-trips an episode with parsed name JSON, media URL and no optional keys', () => {
    const { repos } = open(backend);
    repos.episodes.upsert(episode({ id: 'ep/1 #' }));
    const got = repos.episodes.get('ep/1 #');
    expect(got).toEqual({
      id: 'ep/1 #',
      seriesId: 's1',
      title: 'Episode 1',
      fileName: 'Show - 01.mkv',
      filePath: '/anime/Show/Show - 01.mkv',
      container: 'mkv',
      sizeBytes: 1_234_567_890_123,
      parsedName: parsed,
      subtitleTracks: [],
      mediaUrl: '/media/ep%2F1%20%23',
    });
    expect(got && ('durationMs' in got || 'progress' in got)).toBe(false);
    expect(repos.episodes.get('missing')).toBeUndefined();
  });

  it('upsert updates fields but keeps a known duration when the new record has none', () => {
    const { repos } = open(backend);
    repos.episodes.upsert(episode({ durationMs: 1_440_000 }));
    repos.episodes.upsert(episode({ title: 'Renamed', sizeBytes: 5, container: 'mp4', sortIndex: 3 }));
    expect(repos.episodes.get('e1')).toMatchObject({ title: 'Renamed', sizeBytes: 5, container: 'mp4', durationMs: 1_440_000 });
    repos.episodes.upsert(episode({ durationMs: 1_000 }));
    expect(repos.episodes.get('e1')?.durationMs).toBe(1_000);
  });

  it('rejects an episode whose series does not exist (foreign key)', () => {
    const { repos } = open(backend);
    expect(() => repos.episodes.upsert(episode({ seriesId: 'ghost' }))).toThrow(/FOREIGN KEY/);
  });

  it('lists by sort_index then file name, scoped to the series', () => {
    const { repos } = open(backend);
    repos.series.upsert({ id: 's2', title: 'Other', sourcePath: '/anime/Other', addedAt: 1 });
    repos.episodes.upsert(episode({ id: 'c', fileName: 'c.mkv', filePath: '/c', sortIndex: 2 }));
    repos.episodes.upsert(episode({ id: 'b', fileName: 'b.mkv', filePath: '/b', sortIndex: 1 }));
    repos.episodes.upsert(episode({ id: 'a', fileName: 'a.mkv', filePath: '/a', sortIndex: 1 }));
    repos.episodes.upsert(episode({ id: 'z', seriesId: 's2', fileName: 'z.mkv', filePath: '/z', sortIndex: 0 }));
    expect(repos.episodes.listBySeries('s1').map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(repos.episodes.idsBySeries('s1').sort()).toEqual(['a', 'b', 'c']);
    expect(repos.episodes.listBySeries('s2').map((e) => e.id)).toEqual(['z']);
    expect(repos.episodes.listBySeries('none')).toEqual([]);
  });

  it('saveProgress upserts (rounded) progress and back-fills an unknown duration only', () => {
    const { repos } = open(backend);
    repos.episodes.upsert(episode());
    repos.episodes.saveProgress('e1', { positionMs: 1_234.6, durationMs: 60_000.4, updatedAt: 10 });
    expect(repos.episodes.get('e1')).toMatchObject({
      durationMs: 60_000,
      progress: { positionMs: 1_235, durationMs: 60_000, updatedAt: 10 },
    });
    repos.episodes.saveProgress('e1', { positionMs: 5_000, durationMs: 99_999, updatedAt: 20 });
    const got = repos.episodes.get('e1');
    expect(got?.progress).toEqual({ positionMs: 5_000, durationMs: 99_999, updatedAt: 20 });
    // duration_ms was already set → not overwritten by progress.
    expect(got?.durationMs).toBe(60_000);
    expect(repos.episodes.listBySeries('s1')[0]?.progress?.positionMs).toBe(5_000);
  });

  it('saveProgress with durationMs 0 does not set a duration', () => {
    const { repos } = open(backend);
    repos.episodes.upsert(episode());
    repos.episodes.saveProgress('e1', { positionMs: 1, durationMs: 0, updatedAt: 1 });
    expect(repos.episodes.get('e1')?.durationMs).toBeUndefined();
  });

  it('saveProgress for an unknown episode violates the foreign key', () => {
    const { repos } = open(backend);
    expect(() => repos.episodes.saveProgress('ghost', { positionMs: 1, durationMs: 2, updatedAt: 3 })).toThrow(/FOREIGN KEY/);
  });

  it('embeds subtitle tracks (default first) in get() and listBySeries()', () => {
    const { repos } = open(backend);
    repos.episodes.upsert(episode());
    repos.tracks.upsert({ id: 't-a', episodeId: 'e1', origin: 'external', format: 'srt', label: 'A' }, 1);
    repos.tracks.upsert({ id: 't-b', episodeId: 'e1', origin: 'external', format: 'ass', label: 'B', isDefault: true }, 2);
    expect(repos.episodes.get('e1')?.subtitleTracks.map((t) => t.id)).toEqual(['t-b', 't-a']);
    expect(repos.episodes.listBySeries('s1')[0]?.subtitleTracks).toHaveLength(2);
  });

  it('remove() reports whether a row was deleted', () => {
    const { repos } = open(backend);
    repos.episodes.upsert(episode());
    expect(repos.episodes.remove('e1')).toBe(true);
    expect(repos.episodes.remove('e1')).toBe(false);
  });
});
