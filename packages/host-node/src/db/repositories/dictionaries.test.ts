import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { PartOfSpeech, VocabEntry } from '@kotori/core';
import { openDatabase, type Database } from '../sqlite';
import { DictionaryRepository, DICT_IMPORT_BATCH_ROWS, type DictImportProgress } from './dictionaries';
import { createRepositories } from './index';

const dbs: Database[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(path = ':memory:'): { db: Database; repo: DictionaryRepository } {
  const db = openDatabase(path);
  dbs.push(db);
  return { db, repo: new DictionaryRepository(db) };
}

interface ZipSpec {
  readonly index?: Record<string, unknown> | string | null;
  readonly terms?: readonly (readonly unknown[])[][];
  readonly meta?: readonly (readonly unknown[])[][];
  /** Wrapper directory (BUG-2053) and index.json placement. */
  readonly dir?: string;
  readonly indexLast?: boolean;
  readonly extra?: Record<string, Uint8Array>;
}

function buildZip(spec: ZipSpec): Uint8Array {
  const prefix = spec.dir ? `${spec.dir}/` : '';
  const files: Array<[string, Uint8Array]> = [];
  const index = spec.index === undefined ? { title: 'Test Dict', revision: '1', format: 3 } : spec.index;
  const indexEntry: [string, Uint8Array] | undefined = index === null ? undefined : [`${prefix}index.json`, strToU8(typeof index === 'string' ? index : JSON.stringify(index))];
  if (indexEntry && !spec.indexLast) files.push(indexEntry);
  (spec.terms ?? []).forEach((bank, i) => files.push([`${prefix}term_bank_${i + 1}.json`, strToU8(JSON.stringify(bank))]));
  (spec.meta ?? []).forEach((bank, i) => files.push([`${prefix}term_meta_bank_${i + 1}.json`, strToU8(JSON.stringify(bank))]));
  for (const [name, data] of Object.entries(spec.extra ?? {})) files.push([name, data]);
  if (indexEntry && spec.indexLast) files.push(indexEntry);
  const zippable: Zippable = {};
  for (const [name, data] of files) zippable[name] = data;
  return zipSync(zippable, { level: 6 });
}

async function* chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

function count(db: Database, table: string, dictId?: string): number {
  const row = (dictId === undefined ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() : db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE dict_id = ?`).get(dictId)) as { n: number };
  return Number(row.n);
}

// --- realistic fixture dictionaries (rows mirror @kotori/core dict tests) -------

const WTY_TERMS = [
  ['見る', '', 'non-lemma', '', 0, [['みる', ['alternative kanji']]], 0, ''],
  ['みる', '', 'v ichidan vt', '', 0, ['看，观看'], 0, ''],
  ['わかる', '', 'v godan vi', '', 0, ['懂，明白，理解'], 0, ''],
  ['賭ける', '', 'v ichidan vt', '', 0, ['賭博，打賭，押注', '押上，拼上'], 0, ''],
  ['掛ける', '', 'v ichidan vt', '', 0, ['挂，悬挂', '花费'], 0, ''],
  ['逢う', '', 'non-lemma', '', 0, [['会う', ['alternative kanji']]], 0, ''],
  ['会う', '', 'v godan vi', '', 0, ['见面，遇见'], 0, ''],
  ['言う', '', 'v godan vt', '', 0, ['说，讲'], 0, ''],
  ['食べる', '', 'v ichidan vt', '', 0, ['吃'], 0, ''],
];

const JM_TERMS = [
  ['分かる', 'わかる', 'v5r vi', 'v5', 0, ['to understand; to comprehend'], 1001, ''],
  ['賭ける', 'かける', 'v1 vt', 'v1', 0, ['to wager; to bet; to risk'], 2001, ''],
  ['掛ける', 'かける', 'v1 vt', 'v1', 0, ['to hang up; to suspend'], 2002, ''],
  ['駆ける', 'かける', 'v1 vi', 'v1', 0, ['to run; to dash'], 2003, ''],
  ['欠ける', 'かける', 'v1 vi', 'v1', 0, ['to be chipped; to be lacking'], 2004, ''],
  ['箸', 'はし', 'n', '', 0, ['chopsticks'], 3001, ''],
  ['端', 'はし', 'n', '', 0, ['end; edge'], 3002, ''],
  ['言う', 'いう', 'v5u vt', 'v5', 0, ['to say'], 5001, ''],
  ['言', 'げん', 'n', '', 0, ['word; remark'], 5002, ''],
];

const KANJIUM_META = [
  ['賭ける', 'pitch', { reading: 'かける', pitches: [{ position: 2 }] }],
  ['掛ける', 'pitch', { reading: 'かける', pitches: [{ position: 2 }] }],
  ['欠ける', 'pitch', { reading: 'かける', pitches: [{ position: 0 }] }],
  ['見る', 'pitch', { reading: 'みる', pitches: [{ position: 1 }] }],
];

const JPDB_META = [
  ['賭ける', 'freq', { reading: 'かける', frequency: { value: 3851, displayValue: '3851' } }],
  ['掛ける', 'freq', { reading: 'かける', frequency: { value: 2055, displayValue: '2055' } }],
  ['掛ける', 'freq', { reading: 'かける', frequency: { value: 202, displayValue: '202㋕' } }],
  ['かける', 'freq', { value: 202, displayValue: '202㋕' }],
  ['分かる', 'freq', { reading: 'わかる', frequency: { value: 50, displayValue: '50' } }],
  ['言う', 'freq', { reading: 'いう', frequency: { value: 30, displayValue: '30' } }],
];

async function importFixtures(repo: DictionaryRepository): Promise<void> {
  await repo.importZipStream(buildZip({ index: { title: 'Wiktionary 日中', revision: 'w1', format: 3 }, terms: [WTY_TERMS] }));
  await repo.importZipStream(buildZip({ index: { title: 'JMdict', revision: 'j1', format: 3 }, terms: [JM_TERMS] }));
  await repo.importZipStream(buildZip({ index: { title: 'Kanjium', revision: 'k1', format: 3 }, meta: [KANJIUM_META] }));
  await repo.importZipStream(buildZip({ index: { title: 'JPDBv2㋕', revision: 'p1', format: 3 }, meta: [JPDB_META] }));
}

const vocab = (id: string, lemma: string, lemmaReading: string, partOfSpeech: PartOfSpeech, meaning: string): VocabEntry => ({
  id,
  charSpan: [0, lemma.length],
  alignment: 'exact',
  surface: lemma,
  lemma,
  lemmaReading,
  lemmaRuby: [],
  partOfSpeech,
  meaning,
});

// ---------------------------------------------------------------------------

describe('DictionaryRepository import', () => {
  it('imports term_bank + term_meta_bank rows from a wrapped ZIP whose index.json comes last', async () => {
    const { db, repo } = open();
    const events: DictImportProgress[] = [];
    const info = await repo.importZipStream(
      buildZip({
        dir: 'MyDict',
        indexLast: true,
        index: { title: 'Mixed', revision: '2024.1', format: 3, attribution: 'CC BY-SA', indexUrl: 'https://example.com/index.json', url: 'https://example.com' },
        terms: [WTY_TERMS.slice(0, 4), WTY_TERMS.slice(4)],
        meta: [KANJIUM_META, JPDB_META],
        extra: { '__MACOSX/._index.json': strToU8('junk'), 'MyDict/styles.css': strToU8('a{}') },
      }),
      { fallbackTitle: 'mixed.zip', now: 1234 },
      (p) => events.push(p),
    );
    expect(info).toMatchObject({
      title: 'Mixed',
      revision: '2024.1',
      kind: 'mixed',
      status: 'ready',
      priority: 0,
      enabled: true,
      termCount: WTY_TERMS.length,
      attribution: 'CC BY-SA',
      indexUrl: 'https://example.com/index.json',
      sourceUrl: 'https://example.com',
      importedAt: 1234,
    });
    // Meta records are merged per (expression, mode): 掛ける freq has two entries in one record.
    expect(info.metaCount).toBe(count(db, 'dict_meta', info.id));
    expect(info.metaCount).toBe(9);
    const kake = repo.findMeta([info.id], ['掛ける']).find((m) => m.mode === 'freq');
    expect(kake?.entries).toHaveLength(2);
    expect(repo.list()).toEqual([info]);
    expect(events.at(-1)).toMatchObject({ dictId: info.id, title: 'Mixed', phase: 'ready', processedRows: WTY_TERMS.length + KANJIUM_META.length + JPDB_META.length });

    const terms = repo.findTerms([info.id], ['見る']);
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ expression: '見る', reading: '', redirectTo: 'みる', keys: ['見る'], senses: [] });
    // Kana keys match readings too (empty readings are never indexed).
    expect(repo.findTerms([info.id], ['みる']).map((t) => t.expression)).toEqual(['みる']);
  });

  it('streams across tiny chunk boundaries and writes in batches of 2,500 rows', async () => {
    const { db, repo } = open();
    const rows = Array.from({ length: DICT_IMPORT_BATCH_ROWS * 2 + 17 }, (_, i) => [`語${i}`, `ご${i}`, 'n', '', 0, [`gloss ${i} 日本語`], i, '']);
    const meta = Array.from({ length: 3000 }, (_, i) => [`語${i % 1200}`, 'freq', { value: i, displayValue: String(i) }]);
    const bytes = buildZip({ terms: [rows.slice(0, 3000), rows.slice(3000)], meta: [meta.slice(0, 2600), meta.slice(2600)] });
    const progress: number[] = [];
    const info = await repo.importZipStream(chunked(bytes, 7), {}, (p) => {
      if (p.phase === 'importing') progress.push(p.processedRows);
    });
    expect(info.termCount).toBe(rows.length);
    expect(count(db, 'dict_terms', info.id)).toBe(rows.length);
    // 3,000 meta rows over 1,200 expressions; records drained mid-bank are merged, not overwritten.
    expect(info.metaCount).toBe(1200);
    const merged = repo.findMeta([info.id], ['語0']);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.entries.map((e) => (e as { value: number }).value)).toEqual([0, 1200, 2400]);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.every((n, i) => i === 0 || n >= (progress[i - 1] ?? 0))).toBe(true);
    // seq is a dense 0..N-1 ordinal across banks.
    const maxSeq = (db.prepare('SELECT MAX(seq) AS m FROM dict_terms WHERE dict_id = ?').get(info.id) as { m: number }).m;
    expect(Number(maxSeq)).toBe(rows.length - 1);
  });

  it('accepts Uint8Array input directly and falls back when the streaming decoder fails', async () => {
    const { repo } = open();
    const bytes = buildZip({ terms: [WTY_TERMS] });
    const info = await repo.importZipStream(bytes);
    expect(info.termCount).toBe(WTY_TERMS.length);
    // A broken stream with a readAll() fallback still imports (in-memory pass).
    async function* broken(): AsyncIterable<Uint8Array> {
      yield bytes.slice(0, 10);
      throw new Error('stream reset');
    }
    const again = await repo.importZipStream(broken(), { readAll: async () => buildZip({ index: { title: 'Other', revision: '1', format: 3 }, terms: [WTY_TERMS] }) });
    expect(again).toMatchObject({ title: 'Other', termCount: WTY_TERMS.length });
  });

  it('removes every trace of a failed import (missing index, corrupt bank, empty dictionary)', async () => {
    const { db, repo } = open();
    const failures: DictImportProgress[] = [];
    const onProgress = (p: DictImportProgress): void => {
      if (p.phase === 'failed') failures.push(p);
    };
    await expect(repo.importZipStream(buildZip({ index: null, terms: [WTY_TERMS] }), { fallbackTitle: 'noindex.zip' }, onProgress)).rejects.toMatchObject({ code: 'parse', message: expect.stringMatching(/index\.json/) });
    await expect(repo.importZipStream(buildZip({ index: { title: 'Old', revision: '1', format: 1 }, terms: [WTY_TERMS] }))).rejects.toMatchObject({ code: 'parse' });
    const corrupt = zipSync({ 'index.json': strToU8(JSON.stringify({ title: 'Bad', revision: '1', format: 3 })), 'term_bank_1.json': strToU8('[["a","",'), 'term_bank_2.json': strToU8('[["b","","","",0,["x"],0,""]]') });
    await expect(repo.importZipStream(corrupt)).rejects.toMatchObject({ code: 'parse', message: expect.stringMatching(/term_bank_1\.json/) });
    await expect(repo.importZipStream(buildZip({ terms: [] }))).rejects.toMatchObject({ code: 'parse', message: expect.stringMatching(/no term or meta rows/) });
    await expect(repo.importZipStream(strToU8('definitely not a zip file'))).rejects.toMatchObject({ code: 'parse' });
    expect(count(db, 'dictionaries')).toBe(0);
    expect(count(db, 'dict_terms')).toBe(0);
    expect(count(db, 'dict_meta')).toBe(0);
    expect(failures[0]).toMatchObject({ title: 'noindex.zip', phase: 'failed' });
  });

  it('purges incomplete imports on startup (createRepositories), cascading to rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kotori-dict-test-'));
    tmpDirs.push(dir);
    const path = join(dir, 'kotori.sqlite');
    const first = open(path);
    const ready = await first.repo.importZipStream(buildZip({ terms: [WTY_TERMS], meta: [KANJIUM_META] }));
    // Simulate a crash mid-import: an `importing` row with some rows already written.
    first.db.prepare("INSERT INTO dictionaries (id, title, revision, kind, status, priority, enabled, term_count, meta_count, imported_at) VALUES ('dict_crash', 'Crashed', '', 'term', 'importing', 0, 1, 0, 0, 1)").run();
    first.db.prepare("INSERT INTO dict_terms (dict_id, seq, expression, reading, senses_json) VALUES ('dict_crash', 0, '猫', 'ねこ', '[]')").run();
    first.db.prepare("INSERT INTO dict_meta (dict_id, expression, mode, data_json) VALUES ('dict_crash', '猫', 'freq', '[]')").run();
    expect(first.repo.list().map((d) => d.id)).toEqual([ready.id]); // importing rows are invisible
    first.db.close();

    const db = openDatabase(path);
    dbs.push(db);
    const repos = createRepositories(db);
    expect(repos.dictionaries.get('dict_crash')).toBeUndefined();
    expect(count(db, 'dict_terms', 'dict_crash')).toBe(0);
    expect(count(db, 'dict_meta', 'dict_crash')).toBe(0);
    expect(repos.dictionaries.list().map((d) => d.id)).toEqual([ready.id]);
    expect(count(db, 'dict_terms', ready.id)).toBe(WTY_TERMS.length);
    expect(repos.dictionaries.purgeIncompleteImports()).toBe(0);
  });

  it('blue-green update replaces the same-title dictionary and inherits priority / enabled', async () => {
    const { db, repo } = open();
    const other = await repo.importZipStream(buildZip({ index: { title: 'Other', revision: '1', format: 3 }, terms: [JM_TERMS] }));
    const v1 = await repo.importZipStream(buildZip({ index: { title: 'Wiktionary 日中', revision: 'v1', format: 3 }, terms: [WTY_TERMS] }));
    expect(v1.priority).toBe(1);
    repo.update(v1.id, { priority: 7, enabled: false });
    const v2 = await repo.importZipStream(buildZip({ index: { title: 'Wiktionary 日中', revision: 'v2', format: 3 }, terms: [WTY_TERMS.slice(0, 3)] }));
    expect(v2.id).not.toBe(v1.id);
    expect(v2).toMatchObject({ revision: 'v2', priority: 7, enabled: false, termCount: 3 });
    expect(repo.get(v1.id)).toBeUndefined();
    expect(count(db, 'dict_terms', v1.id)).toBe(0);
    expect(repo.list().map((d) => [d.title, d.revision])).toEqual([
      ['Other', '1'],
      ['Wiktionary 日中', 'v2'],
    ]);
    expect(count(db, 'dict_terms', other.id)).toBe(JM_TERMS.length);
  });

  it('a failed re-import keeps the previous version untouched', async () => {
    const { db, repo } = open();
    const v1 = await repo.importZipStream(buildZip({ terms: [WTY_TERMS] }));
    const corrupt = zipSync({ 'index.json': strToU8(JSON.stringify({ title: 'Test Dict', revision: '2', format: 3 })), 'term_bank_1.json': strToU8('[["a","",') });
    await expect(repo.importZipStream(corrupt)).rejects.toBeTruthy();
    expect(repo.list()).toEqual([v1]);
    expect(count(db, 'dict_terms')).toBe(WTY_TERMS.length);
  });

  it('update / remove validate ids and patches', async () => {
    const { db, repo } = open();
    const info = await repo.importZipStream(buildZip({ terms: [WTY_TERMS], meta: [KANJIUM_META] }));
    expect(repo.update(info.id, { enabled: false })).toMatchObject({ enabled: false, priority: 0 });
    expect(repo.update(info.id, { priority: 3 })).toMatchObject({ enabled: false, priority: 3 });
    expect(() => repo.update('nope', { enabled: true })).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => repo.update(info.id, { priority: Number.NaN })).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    repo.remove(info.id);
    expect(() => repo.remove(info.id)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(count(db, 'dict_terms')).toBe(0);
    expect(count(db, 'dict_meta')).toBe(0);
  });
});

describe('DictionaryRepository lookups', () => {
  it('uses the expression / reading / meta indexes (never a full table scan)', async () => {
    const { db, repo } = open();
    await importFixtures(repo);
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    const terms = plan("SELECT * FROM dict_terms WHERE expression IN ('a','b') AND +dict_id IN ('x') UNION ALL SELECT * FROM dict_terms WHERE reading != '' AND reading IN ('a','b') AND +dict_id IN ('x')");
    expect(terms).toContain('idx_dict_terms_expr');
    expect(terms).toContain('idx_dict_terms_reading');
    expect(terms).not.toMatch(/SCAN dict_terms(?! USING)/);
    expect(plan("SELECT * FROM dict_meta WHERE expression IN ('a') AND +dict_id IN ('x')")).toContain('idx_dict_meta_lookup');
  });

  it('enrichVocab: kanji match, R1 ㋕ guard, redirects, safe reading fallback, uncertain homographs, empty', async () => {
    const { repo } = open();
    await importFixtures(repo);
    const out = await repo.enrichVocab([
      vocab('v0', '賭ける', 'かける', 'verb', '赌上，押上'),
      vocab('v1', '見る', 'みる', 'verb', '看'),
      vocab('v2', '分かる', 'わかる', 'verb', '明白'),
      vocab('v3', 'かける', 'かける', 'verb', '豁出去，拼一把'),
      vocab('v4', '橋', 'はし', 'noun', '桥'),
      vocab('v5', '逢う', 'あう', 'verb', '见面'),
    ]);
    // Exact kanji hit across dictionaries + its own JPDB rank, never the bare kana 202㋕ row (R1).
    expect(out['v0']).toMatchObject({ status: 'matched', headword: '賭ける', reading: 'かける' });
    expect(out['v0']?.senseGroups.map((g) => [g.dictTitle, g.expression])).toEqual([
      ['Wiktionary 日中', '賭ける'],
      ['JMdict', '賭ける'],
    ]);
    expect(out['v0']?.senseGroups[0]?.matchedSenseIdx).toBe(1);
    expect(out['v0']?.frequencies).toEqual([expect.objectContaining({ dictTitle: 'JPDBv2㋕', value: 3851, displayValue: '3851' })]);
    expect(out['v0']?.frequencies.some((f) => f.kanaOnly)).toBe(false);
    expect(out['v0']?.pitches).toEqual([{ reading: 'かける', position: 2, sources: ['Kanjium'] }]);
    // One-hop redirect 見る → みる (fetched in the second batched round), pitch keyed by the AI lemma.
    expect(out['v1']).toMatchObject({ status: 'matched', headword: '見る', senseGroups: [{ expression: 'みる', senses: [{ gloss: '看，观看' }] }] });
    expect(out['v1']?.pitches).toEqual([{ reading: 'みる', position: 1, sources: ['Kanjium'] }]);
    expect(out['v5']).toMatchObject({ status: 'matched', senseGroups: [{ expression: '会う', senses: [{ gloss: '见面，遇见' }] }] });
    // Safe reading fallback: wty only has kana わかる, JMdict hits 分かる exactly.
    expect(out['v2']?.status).toBe('matched');
    expect(out['v2']?.senseGroups.map((g) => [g.dictTitle, g.expression])).toEqual([
      ['Wiktionary 日中', 'わかる'],
      ['JMdict', '分かる'],
    ]);
    expect(out['v2']?.frequencies.map((f) => f.value)).toEqual([50]);
    // Kana lemma with a paraphrased meaning: explicit homograph candidates with their own pitch / freq.
    expect(out['v3']?.status).toBe('uncertain');
    expect(out['v3']?.frequencies).toEqual([expect.objectContaining({ value: 202, displayValue: '202㋕', kanaOnly: true })]);
    const candidates = out['v3']?.candidates ?? [];
    expect(candidates.map((c) => c.expression).sort()).toEqual(['掛ける', '欠ける', '賭ける', '駆ける'].sort());
    expect(candidates.find((c) => c.expression === '賭ける')?.frequencies.map((f) => f.displayValue)).toEqual(['3851']);
    expect(candidates.find((c) => c.expression === '欠ける')?.pitches[0]).toMatchObject({ position: 0 });
    // Orthography guard: 箸 / 端 never stand in for 橋.
    expect(out['v4']).toMatchObject({ status: 'empty', senseGroups: [] });
  });

  it('ignores disabled dictionaries and returns empty enrichment without any', async () => {
    const { repo } = open();
    expect(await repo.enrichVocab([vocab('v0', '賭ける', 'かける', 'verb', 'x')])).toEqual({ v0: { status: 'empty', pitches: [], frequencies: [], senseGroups: [] } });
    await importFixtures(repo);
    const wty = repo.list().find((d) => d.title === 'Wiktionary 日中')!;
    repo.update(wty.id, { enabled: false });
    const out = await repo.enrichVocab([vocab('v0', '賭ける', 'かける', 'verb', '赌上，押上')]);
    expect(out['v0']?.senseGroups.map((g) => g.dictTitle)).toEqual(['JMdict']);
    // Priority reorders sense groups.
    repo.update(wty.id, { enabled: true, priority: 99 });
    const reordered = await repo.enrichVocab([vocab('v0', '賭ける', 'かける', 'verb', '赌上，押上')]);
    expect(reordered['v0']?.senseGroups.map((g) => g.dictTitle)).toEqual(['JMdict', 'Wiktionary 日中']);
  });

  it('lookupPrefix deinflects 言っちゃった → 言う and 食べさせられなかった → 食べる', async () => {
    const { repo } = open();
    await importFixtures(repo);
    const iu = await repo.lookupPrefix('言っちゃったんだよ');
    expect(iu[0]).toMatchObject({ surface: '言っちゃった', matchedLength: 6, lemma: '言う', reading: 'いう' });
    expect(iu[0]?.deinflectChain.length).toBeGreaterThanOrEqual(2);
    expect(iu[0]?.frequencies.map((f) => f.value)).toEqual([30]);
    expect(iu[0]?.senseGroups.map((g) => g.dictTitle)).toEqual(['Wiktionary 日中', 'JMdict']);
    expect(iu.findIndex((m) => m.lemma === '言')).toBeGreaterThan(0);

    const taberu = await repo.lookupPrefix('食べさせられなかった。');
    expect(taberu[0]).toMatchObject({ lemma: '食べる', matchedLength: 10, senseGroups: [{ senses: [{ gloss: '吃' }] }] });

    const miru = await repo.lookupPrefix('見てた');
    expect(miru[0]).toMatchObject({ lemma: 'みる', matchedLength: 3 });
    expect(miru[0]?.pitches).toEqual([]);
    expect(await repo.lookupPrefix('')).toEqual([]);
  });
});
