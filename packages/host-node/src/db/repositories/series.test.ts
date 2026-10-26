import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedEpisodeName } from '@kotori/core';
import { openDatabase, type Database } from '../sqlite';
import { createRepositories, type EpisodeRecord, type Repositories, type SeriesRecord } from './index';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

type Backend = 'memory' | 'file';

function open(backend: Backend): { db: Database; repos: Repositories } {
  let path = ':memory:';
  if (backend === 'file') {
    const dir = mkdtempSync(join(tmpdir(), 'kotori-series-test-'));
    tmpDirs.push(dir);
    path = join(dir, 'kotori.db');
  }
  const db = openDatabase(path);
  dbs.push(db);
  return { db, repos: createRepositories(db) };
}

function count(db: Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const parsed: ParsedEpisodeName = { raw: '[G] Show - 01.mkv', title: 'Show', episode: 1, isBatch: false };

function series(over: Partial<SeriesRecord> = {}): SeriesRecord {
  return { id: 's1', title: 'Show', sourcePath: '/anime/Show', addedAt: 1_000, ...over };
}

function episode(over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: 'e1',
    seriesId: 's1',
    title: 'Episode 1',
    fileName: 'Show - 01.mkv',
    filePath: '/anime/Show/Show - 01.mkv',
    container: 'mkv',
    sizeBytes: 123,
    parsedName: parsed,
    sortIndex: 0,
    ...over,
  };
}

describe.each<Backend>(['memory', 'file'])('SeriesRepository (%s db)', (backend) => {
  it('round-trips a minimal series without optional keys', () => {
    const { repos } = open(backend);
    repos.series.upsert(series());
    const got = repos.series.get('s1');
    expect(got).toEqual({ id: 's1', title: 'Show', sourcePath: '/anime/Show', episodeCount: 0, addedAt: 1_000 });
    expect(got && 'coverUrl' in got).toBe(false);
    expect(repos.series.getByPath('/anime/Show')?.id).toBe('s1');
    expect(repos.series.get('missing')).toBeUndefined();
    expect(repos.series.getByPath('/nope')).toBeUndefined();
    expect(repos.series.coverPath('s1')).toBeUndefined();
  });

  it('exposes a cover URL (not the file path) and keeps the cover path on upsert without one', () => {
    const { repos } = open(backend);
    repos.series.upsert(series({ id: 'a/b c', coverPath: '/covers/x.jpg', jimakuEntryId: 7, anilistId: 99 }));
    expect(repos.series.get('a/b c')).toMatchObject({ coverUrl: '/api/anime/series/a%2Fb%20c/cover', jimakuEntryId: 7, anilistId: 99 });
    expect(repos.series.coverPath('a/b c')).toBe('/covers/x.jpg');

    // Re-scan: new title/path, no cover → cover retained (COALESCE), added_at & jimaku untouched.
    repos.series.upsert(series({ id: 'a/b c', title: 'Renamed', sourcePath: '/anime/Renamed', addedAt: 5_000 }));
    expect(repos.series.get('a/b c')).toEqual({
      id: 'a/b c',
      title: 'Renamed',
      sourcePath: '/anime/Renamed',
      episodeCount: 0,
      addedAt: 1_000,
      coverUrl: '/api/anime/series/a%2Fb%20c/cover',
      jimakuEntryId: 7,
      anilistId: 99,
    });
    expect(repos.series.coverPath('a/b c')).toBe('/covers/x.jpg');

    repos.series.upsert(series({ id: 'a/b c', sourcePath: '/anime/Renamed', coverPath: '/covers/y.png' }));
    expect(repos.series.coverPath('a/b c')).toBe('/covers/y.png');
  });

  it('rejects a second series id on the same source path (UNIQUE)', () => {
    const { repos } = open(backend);
    repos.series.upsert(series());
    expect(() => repos.series.upsert(series({ id: 's2' }))).toThrow(/UNIQUE/);
  });

  it('setJimaku sets/clears the entry and only overwrites anilistId when provided', () => {
    const { repos } = open(backend);
    repos.series.upsert(series());
    repos.series.setJimaku('s1', 42, 1234);
    expect(repos.series.get('s1')).toMatchObject({ jimakuEntryId: 42, anilistId: 1234 });
    repos.series.setJimaku('s1', 43);
    expect(repos.series.get('s1')).toMatchObject({ jimakuEntryId: 43, anilistId: 1234 });
    repos.series.setJimaku('s1', undefined);
    const got = repos.series.get('s1');
    expect(got?.jimakuEntryId).toBeUndefined();
    expect(got && 'jimakuEntryId' in got).toBe(false);
    expect(got?.anilistId).toBe(1234);
  });

  it('counts episodes and orders list() by last watched / added desc, then title', () => {
    const { repos } = open(backend);
    repos.series.upsert(series({ id: 'old', title: 'B old', sourcePath: '/a/old', addedAt: 100 }));
    repos.series.upsert(series({ id: 'new', title: 'A new', sourcePath: '/a/new', addedAt: 300 }));
    repos.series.upsert(series({ id: 'tie', title: 'A tie', sourcePath: '/a/tie', addedAt: 100 }));
    repos.episodes.upsert(episode({ id: 'o1', seriesId: 'old', filePath: '/a/old/1.mkv' }));
    repos.episodes.upsert(episode({ id: 'o2', seriesId: 'old', filePath: '/a/old/2.mkv' }));
    expect(repos.series.list().map((s) => s.id)).toEqual(['new', 'tie', 'old']);

    repos.series.touchWatched('old', 'o2', 1_000);
    const list = repos.series.list();
    expect(list.map((s) => s.id)).toEqual(['old', 'new', 'tie']);
    expect(list[0]).toMatchObject({ episodeCount: 2, lastWatchedEpisodeId: 'o2', lastWatchedAt: 1_000 });
    expect(list[1]?.episodeCount).toBe(0);
  });

  it('remove() reports whether a row was deleted', () => {
    const { repos } = open(backend);
    repos.series.upsert(series());
    expect(repos.series.remove('s1')).toBe(true);
    expect(repos.series.remove('s1')).toBe(false);
    expect(repos.series.get('s1')).toBeUndefined();
  });

  it('cascades series → episodes → subtitle tracks + playback progress', () => {
    const { db, repos } = open(backend);
    repos.series.upsert(series());
    repos.series.upsert(series({ id: 'other', sourcePath: '/anime/Other' }));
    repos.episodes.upsert(episode());
    repos.episodes.upsert(episode({ id: 'e2', filePath: '/anime/Show/2.mkv' }));
    repos.episodes.upsert(episode({ id: 'x1', seriesId: 'other', filePath: '/anime/Other/1.mkv' }));
    repos.tracks.upsert({ id: 't1', episodeId: 'e1', origin: 'external', format: 'ass', label: 'ja' });
    repos.tracks.upsert({ id: 't2', episodeId: 'e2', origin: 'embedded', format: 'srt', label: 'en', streamIndex: 2 });
    repos.tracks.upsert({ id: 'tx', episodeId: 'x1', origin: 'external', format: 'srt', label: 'ja' });
    repos.episodes.saveProgress('e1', { positionMs: 10, durationMs: 100, updatedAt: 1 });
    repos.episodes.saveProgress('x1', { positionMs: 10, durationMs: 100, updatedAt: 1 });

    expect(repos.series.remove('s1')).toBe(true);
    expect(repos.episodes.listBySeries('s1')).toEqual([]);
    expect(repos.tracks.get('t1')).toBeUndefined();
    expect(repos.tracks.get('t2')).toBeUndefined();
    expect(count(db, 'anime_episodes')).toBe(1);
    expect(count(db, 'subtitle_tracks')).toBe(1);
    expect(count(db, 'playback_progress')).toBe(1);
    expect(repos.episodes.get('x1')?.subtitleTracks.map((t) => t.id)).toEqual(['tx']);
  });

  it('cascades episode removal to its tracks and progress only', () => {
    const { db, repos } = open(backend);
    repos.series.upsert(series());
    repos.episodes.upsert(episode());
    repos.tracks.upsert({ id: 't1', episodeId: 'e1', origin: 'external', format: 'ass', label: 'ja' });
    repos.episodes.saveProgress('e1', { positionMs: 10, durationMs: 100, updatedAt: 1 });
    expect(repos.episodes.remove('e1')).toBe(true);
    expect(count(db, 'subtitle_tracks')).toBe(0);
    expect(count(db, 'playback_progress')).toBe(0);
    expect(repos.series.get('s1')?.episodeCount).toBe(0);
  });
});
