import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FollowUpMessage, SentenceExplanation } from '@kotori/core';
import { openDatabase, type Database } from '../sqlite';
import { ExplanationRepository } from './explanations';
import { createRepositories, type Repositories } from './index';

const tmpDirs: string[] = [];
const dbs: Database[] = [];

type Backend = 'memory' | 'file';

function open(backend: Backend): { db: Database; repos: Repositories } {
  let path = ':memory:';
  if (backend === 'file') {
    const dir = mkdtempSync(join(tmpdir(), 'kotori-expl-test-'));
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

function expl(over: Partial<SentenceExplanation> = {}): SentenceExplanation {
  return {
    id: 'x1',
    sentence: '猫が好き',
    ruby: [
      { base: '猫', ruby: 'ねこ', charSpan: [0, 1] },
      { base: 'が好き', charSpan: [1, 4] },
    ],
    translation: '喜欢猫',
    chunks: [],
    vocab: [],
    grammar: [],
    register: 'plain',
    targetLanguage: 'zh-CN',
    model: 'gemini-2.5-flash',
    promptVersion: 'v1',
    createdAt: 1_000,
    fromCache: true,
    usage: { promptTokens: 10, outputTokens: 20, cachedTokens: 5 },
    ...over,
  };
}

const msg = (id: string, over: Partial<FollowUpMessage> = {}): FollowUpMessage => ({ id, role: 'user', text: `q ${id}`, createdAt: 1, ...over });

describe.each<Backend>(['memory', 'file'])('ExplanationRepository (%s db)', (backend) => {
  it('put stores fromCache=false and get round-trips the full JSON', () => {
    const { repos } = open(backend);
    repos.explanations.put(expl());
    expect(repos.explanations.get('x1')).toEqual({ ...expl(), fromCache: false });
    expect(repos.explanations.get('missing')).toBeUndefined();
    expect(repos.explanations.count()).toBe(1);
  });

  it('persists to the table: a fresh repository instance (cold cache) reads it back', () => {
    const { db, repos } = open(backend);
    repos.explanations.put(expl());
    const cold = new ExplanationRepository(db);
    expect(cold.get('x1')).toEqual({ ...expl(), fromCache: false });
    const row = db.prepare('SELECT sentence, target_language, model, prompt_version, created_at FROM explanations WHERE id = ?').get('x1');
    expect(row).toEqual({ sentence: '猫が好き', target_language: 'zh-CN', model: 'gemini-2.5-flash', prompt_version: 'v1', created_at: 1_000 });
  });

  it('put on an existing id overwrites json / created_at (upsert, single row)', () => {
    const { db, repos } = open(backend);
    repos.explanations.put(expl());
    repos.explanations.put(expl({ translation: '我喜欢猫', createdAt: 2_000 }));
    expect(repos.explanations.count()).toBe(1);
    expect(new ExplanationRepository(db).get('x1')).toMatchObject({ translation: '我喜欢猫', createdAt: 2_000, fromCache: false });
  });

  it('serves hits from the in-memory hot cache (survives a direct row delete)', () => {
    const { db, repos } = open(backend);
    repos.explanations.put(expl());
    db.prepare('DELETE FROM explanations').run();
    expect(repos.explanations.get('x1')?.translation).toBe('喜欢猫');
    expect(new ExplanationRepository(db).get('x1')).toBeUndefined();
  });

  it('a DB read populates the hot cache', () => {
    const { db } = open(backend);
    new ExplanationRepository(db).put(expl());
    const repo = new ExplanationRepository(db);
    expect(repo.get('x1')).toBeDefined();
    db.prepare('DELETE FROM explanations').run();
    expect(repo.get('x1')).toBeDefined();
  });

  it('hot cache is bounded (256) and evicts the oldest inserted entry; re-put refreshes it', () => {
    const { db } = open(backend);
    const repo = new ExplanationRepository(db);
    for (let i = 0; i < 256; i++) repo.put(expl({ id: `e${i}` }));
    // A hot hit does NOT refresh recency (insertion order); a re-put does, so e1 becomes the oldest.
    expect(repo.get('e0')).toBeDefined();
    repo.put(expl({ id: 'e0' }));
    repo.put(expl({ id: 'e256' }));
    db.prepare('DELETE FROM explanations').run();
    expect(repo.get('e0')).toBeDefined();
    expect(repo.get('e1')).toBeUndefined();
    expect(repo.get('e2')).toBeDefined();
    expect(repo.get('e256')).toBeDefined();
  });

  it('clear() deletes all explanations, empties the hot cache and also clears all threads', () => {
    const { db, repos } = open(backend);
    repos.explanations.put(expl());
    repos.explanations.put(expl({ id: 'x2' }));
    repos.threads.append('x1', msg('m1'));
    repos.threads.append('x2', msg('m2'));
    repos.threads.append('orphan', msg('m3'));
    expect(repos.explanations.clear()).toBe(2);
    expect(repos.explanations.get('x1')).toBeUndefined();
    expect(repos.explanations.count()).toBe(0);
    expect(count(db, 'follow_up_threads')).toBe(0);
    expect(repos.threads.list('x1')).toEqual([]);
    expect(repos.explanations.clear()).toBe(0);
  });
});

describe.each<Backend>(['memory', 'file'])('ThreadRepository (%s db)', (backend) => {
  it('appends with increasing seq and lists in seq order (not createdAt order)', () => {
    const { db, repos } = open(backend);
    repos.threads.append('x1', msg('m1', { createdAt: 300 }));
    repos.threads.append('x1', msg('m2', { role: 'model', text: '**答**', createdAt: 200, usage: { promptTokens: 1, outputTokens: 2 } }));
    repos.threads.append('x1', msg('m3', { createdAt: 100 }));
    const list = repos.threads.list('x1');
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(list[1]).toEqual({ id: 'm2', role: 'model', text: '**答**', createdAt: 200, usage: { promptTokens: 1, outputTokens: 2 } });
    expect(list[0] && 'usage' in list[0]).toBe(false);
    const seqs = (db.prepare('SELECT seq FROM follow_up_threads WHERE explanation_id = ? ORDER BY seq').all('x1') as Array<{ seq: number }>).map((r) => r.seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('keeps seq independent per explanation', () => {
    const { db, repos } = open(backend);
    repos.threads.append('a', msg('a1'));
    repos.threads.append('b', msg('b1'));
    repos.threads.append('a', msg('a2'));
    expect(repos.threads.list('a').map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(repos.threads.list('b').map((m) => m.id)).toEqual(['b1']);
    expect(db.prepare("SELECT seq FROM follow_up_threads WHERE message_id = 'b1'").get()).toEqual({ seq: 0 });
  });

  it('continues after the max seq when earlier messages were removed', () => {
    const { db, repos } = open(backend);
    repos.threads.append('a', msg('a1'));
    repos.threads.append('a', msg('a2'));
    db.prepare("DELETE FROM follow_up_threads WHERE message_id = 'a1'").run();
    repos.threads.append('a', msg('a3'));
    expect(repos.threads.list('a').map((m) => m.id)).toEqual(['a2', 'a3']);
  });

  it('clear(id) removes one thread; clear() removes all; both return rows removed', () => {
    const { repos } = open(backend);
    repos.threads.append('a', msg('a1'));
    repos.threads.append('a', msg('a2'));
    repos.threads.append('b', msg('b1'));
    expect(repos.threads.clear('a')).toBe(2);
    expect(repos.threads.list('a')).toEqual([]);
    expect(repos.threads.list('b')).toHaveLength(1);
    // A cleared thread restarts at seq 0.
    repos.threads.append('a', msg('a3'));
    expect(repos.threads.list('a').map((m) => m.id)).toEqual(['a3']);
    expect(repos.threads.clear()).toBe(2);
    expect(repos.threads.clear()).toBe(0);
  });
});
