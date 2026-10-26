import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../sqlite';
import { createRepositories, type Repositories, type TrackRecord } from './index';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

type Backend = 'memory' | 'file';

function open(backend: Backend): Repositories {
  let path = ':memory:';
  if (backend === 'file') {
    const dir = mkdtempSync(join(tmpdir(), 'kotori-tracks-test-'));
    tmpDirs.push(dir);
    path = join(dir, 'kotori.db');
  }
  const db = openDatabase(path);
  dbs.push(db);
  const repos = createRepositories(db);
  repos.series.upsert({ id: 's1', title: 'Show', sourcePath: '/anime/Show', addedAt: 1 });
  for (const id of ['e1', 'e2']) {
    repos.episodes.upsert({
      id,
      seriesId: 's1',
      title: id,
      fileName: `${id}.mkv`,
      filePath: `/anime/Show/${id}.mkv`,
      container: 'mkv',
      sizeBytes: 1,
      parsedName: { raw: id, title: id, isBatch: false },
      sortIndex: 0,
    });
  }
  return repos;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rec(over: Partial<TrackRecord> = {}): TrackRecord {
  return { id: 't1', episodeId: 'e1', origin: 'external', format: 'ass', label: 'Japanese', ...over };
}

describe.each<Backend>(['memory', 'file'])('TrackRepository (%s db)', (backend) => {
  it('upsert returns the stored track with defaults (not default, delay 0) and omits null fields', () => {
    const repos = open(backend);
    const t = repos.tracks.upsert(rec());
    expect(t).toEqual({ id: 't1', episodeId: 'e1', origin: 'external', format: 'ass', label: 'Japanese', isDefault: false, delayMs: 0 });
    expect(Object.keys(t).sort()).toEqual(['delayMs', 'episodeId', 'format', 'id', 'isDefault', 'label', 'origin']);
    expect(repos.tracks.get('t1')).toEqual(t);
    expect(repos.tracks.get('missing')).toBeUndefined();
  });

  it('round-trips every optional field', () => {
    const repos = open(backend);
    const t = repos.tracks.upsert(
      rec({ origin: 'embedded', format: 'srt', language: 'ja', filePath: '/subs/x.srt', streamIndex: 3, isDefault: true, cueCount: 321, delayMs: -250 }),
    );
    expect(t).toEqual({
      id: 't1',
      episodeId: 'e1',
      origin: 'embedded',
      format: 'srt',
      label: 'Japanese',
      language: 'ja',
      filePath: '/subs/x.srt',
      streamIndex: 3,
      isDefault: true,
      cueCount: 321,
      delayMs: -250,
    });
  });

  it('re-upsert keeps user delay, default flag and known cue count', () => {
    const repos = open(backend);
    repos.tracks.upsert(rec({ cueCount: 10 }));
    repos.tracks.setDelay('t1', 333.7);
    repos.tracks.setDefault('e1', 't1');
    const t = repos.tracks.upsert(rec({ label: 'JP (rescan)', format: 'vtt', language: 'ja', delayMs: 0, isDefault: false }));
    expect(t).toMatchObject({ label: 'JP (rescan)', format: 'vtt', language: 'ja', delayMs: 334, isDefault: true, cueCount: 10 });
    expect(repos.tracks.upsert(rec({ cueCount: 99 })).cueCount).toBe(99);
    // language is overwritten (not COALESCEd) → cleared when the rescan has none.
    expect(repos.tracks.get('t1')?.language).toBeUndefined();
  });

  it('rejects a track for a missing episode (foreign key)', () => {
    const repos = open(backend);
    expect(() => repos.tracks.upsert(rec({ episodeId: 'ghost' }))).toThrow(/FOREIGN KEY/);
  });

  it('setDefault is exclusive per episode and hasDefault reflects it', () => {
    const repos = open(backend);
    repos.tracks.upsert(rec({ id: 'a' }), 1);
    repos.tracks.upsert(rec({ id: 'b' }), 2);
    repos.tracks.upsert(rec({ id: 'other', episodeId: 'e2', isDefault: true }), 3);
    expect(repos.tracks.hasDefault('e1')).toBe(false);
    repos.tracks.setDefault('e1', 'b');
    expect(repos.tracks.listByEpisode('e1').map((t) => [t.id, t.isDefault])).toEqual([
      ['b', true],
      ['a', false],
    ]);
    repos.tracks.setDefault('e1', 'a');
    expect(repos.tracks.listByEpisode('e1').map((t) => [t.id, t.isDefault])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(repos.tracks.hasDefault('e1')).toBe(true);
    // Other episodes are untouched.
    expect(repos.tracks.get('other')?.isDefault).toBe(true);
  });

  it('lists default first, then by created_at, then label', () => {
    const repos = open(backend);
    repos.tracks.upsert(rec({ id: 'late', label: 'A' }), 30);
    repos.tracks.upsert(rec({ id: 'early-b', label: 'B' }), 10);
    repos.tracks.upsert(rec({ id: 'early-a', label: 'A' }), 10);
    repos.tracks.upsert(rec({ id: 'def', label: 'Z', isDefault: true }), 99);
    expect(repos.tracks.listByEpisode('e1').map((t) => t.id)).toEqual(['def', 'early-a', 'early-b', 'late']);
    expect(repos.tracks.listByEpisode('e2')).toEqual([]);
  });

  it('pruneOrigin removes only unkept tracks of that origin on that episode', () => {
    const repos = open(backend);
    repos.tracks.upsert(rec({ id: 'emb-keep', origin: 'embedded' }));
    repos.tracks.upsert(rec({ id: 'emb-drop', origin: 'embedded' }));
    repos.tracks.upsert(rec({ id: 'ext', origin: 'external' }));
    repos.tracks.upsert(rec({ id: 'e2-emb', episodeId: 'e2', origin: 'embedded' }));
    expect(repos.tracks.pruneOrigin('e1', 'embedded', new Set(['emb-keep']))).toBe(1);
    expect(repos.tracks.listByEpisode('e1').map((t) => t.id).sort()).toEqual(['emb-keep', 'ext']);
    expect(repos.tracks.get('e2-emb')).toBeDefined();
    expect(repos.tracks.pruneOrigin('e1', 'embedded', new Set(['emb-keep']))).toBe(0);
  });

  it('setCueCount / setDelay update in place; remove reports deletion', () => {
    const repos = open(backend);
    repos.tracks.upsert(rec());
    repos.tracks.setCueCount('t1', 12);
    repos.tracks.setDelay('t1', -99.6);
    expect(repos.tracks.get('t1')).toMatchObject({ cueCount: 12, delayMs: -100 });
    expect(repos.tracks.remove('t1')).toBe(true);
    expect(repos.tracks.remove('t1')).toBe(false);
  });
});
