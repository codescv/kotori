import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Zip, ZipPassThrough, strToU8, zipSync, type Zippable } from 'fflate';
import type { DictionaryHost, HostEvent, PartOfSpeech, VocabEntry } from '@kotori/core';
import type { CapacitorHostDeps } from './deps';
import { dictKeyRange } from './dict';
import { openKotoriDb, type KotoriDb } from './storage/idb';
import { bytesToStream } from './storage/unzip-stream';
import { DATA_ROOT, createTestHost, type TestHost } from './testing/harness';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const json = (v: unknown): Uint8Array => strToU8(JSON.stringify(v));

const index = (title: string, revision = '1', extra: Record<string, unknown> = {}) => ({ title, revision, format: 3, ...extra });

/** Realistic rows (see core `disambiguate.test.ts` / `instant-lookup.test.ts`). */
const JM_TERMS: unknown[][] = [
  ['言う', 'いう', 'v5u vt', 'v5', 0, ['to say'], 1, ''],
  ['言', 'げん', 'n', '', 0, ['word; remark'], 2, ''],
  ['食べる', 'たべる', 'v1 vt', 'v1', 0, ['to eat'], 3, ''],
  ['分かる', 'わかる', 'v5r vi', 'v5', 0, ['to understand; to comprehend'], 1001, ''],
  ['賭ける', 'かける', 'v1 vt', 'v1', 0, ['to wager; to bet; to risk'], 2001, ''],
  ['見る', '', 'non-lemma', '', 0, [['みる', ['alternative kanji']]], 0, ''],
  ['みる', '', 'v ichidan vt', '', 0, ['看，观看'], 0, ''],
];

const JM_META: unknown[][] = [
  ['賭ける', 'pitch', { reading: 'かける', pitches: [{ position: 2 }] }],
  ['賭ける', 'freq', { reading: 'かける', frequency: { value: 3851, displayValue: '3851' } }],
  ['言う', 'freq', { reading: 'いう', frequency: { value: 30, displayValue: '30' } }],
];

/** Yomitan zip; insertion order = archive order. */
function makeZip(files: Record<string, unknown>): Uint8Array {
  const z: Zippable = {};
  for (const [name, value] of Object.entries(files)) z[name] = value instanceof Uint8Array ? value : json(value);
  return zipSync(z);
}

/** Streaming `Zip` + `ZipPassThrough`: STORED entries with data descriptors. */
function makeDescriptorZip(files: Record<string, unknown>): Uint8Array {
  const parts: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    parts.push(chunk);
  });
  for (const [name, value] of Object.entries(files)) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(json(value), true);
  }
  zip.end();
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const jmZip = (revision = '1', terms: unknown[][] = JM_TERMS): Uint8Array =>
  makeZip({
    'term_bank_1.json': terms.slice(0, 4),
    'term_bank_2.json': terms.slice(4),
    'term_meta_bank_1.json': JM_META,
    'tag_bank_1.json': [['n', 'partOfSpeech', 0, 'noun', 0]],
    // index.json LAST: seq / rows must not depend on it.
    'index.json': index('JMdict', revision, { attribution: 'EDRDG' }),
  });

const vocab = (id: string, lemma: string, lemmaReading: string, partOfSpeech: PartOfSpeech, meaning: string): VocabEntry => ({
  id,
  charSpan: [0, 1],
  alignment: 'exact',
  surface: lemma,
  lemma,
  lemmaReading,
  lemmaRuby: [],
  partOfSpeech,
  meaning,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const open: TestHost[] = [];
const dbs: KotoriDb[] = [];

async function makeHost(overrides: Partial<CapacitorHostDeps> = {}, shared?: Parameters<typeof createTestHost>[1]): Promise<TestHost & { dict: DictionaryHost; events: HostEvent[] }> {
  const t = await createTestHost(overrides, shared);
  open.push(t);
  const events: HostEvent[] = [];
  t.host.subscribe((e) => events.push(e));
  if (!t.host.dict) throw new Error('host.dict missing');
  return { ...t, dict: t.host.dict, events };
}

/** Second connection to the host's database for raw assertions. */
async function rawDb(t: Pick<TestHost, 'idbFactory'>): Promise<KotoriDb> {
  const db = await openKotoriDb(t.idbFactory, 'kotori-test');
  dbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(open.splice(0).map((t) => t.host.dispose()));
});

const dictEvents = (events: HostEvent[]) => events.filter((e): e is Extract<HostEvent, { type: 'dict-import-progress' }> => e.type === 'dict-import-progress');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IndexedDB schema v2', () => {
  it('upgrades a v1 database in place, keeping existing stores', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('kotori-test', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('settings');
        req.result.createObjectStore('downloads', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({ marker: true }, 'app');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
      req.onerror = () => reject(req.error);
    });
    const db = await rawDb({ idbFactory: factory });
    expect(db.version).toBe(2);
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['settings', 'dictionaries', 'dictTerms', 'dictMeta']));
    expect(await db.get('settings', 'app')).toEqual({ marker: true });
    const tx = db.transaction(['dictTerms', 'dictMeta'], 'readonly');
    expect(tx.objectStore('dictTerms').index('byKey').multiEntry).toBe(true);
    expect(tx.objectStore('dictMeta').index('byExprMode').keyPath).toEqual(['expression', 'mode']);
    await tx.done;
  });
});

describe('dict.importZip', () => {
  it('imports term + meta banks (index.json last, wrapper dir) and reports progress', async () => {
    const t = await makeHost();
    const bytes = makeZip({
      'JMdict/term_bank_1.json': JM_TERMS.slice(0, 4),
      'JMdict/term_meta_bank_1.json': JM_META,
      'JMdict/term_bank_2.json': JM_TERMS.slice(4),
      '__MACOSX/JMdict/._term_bank_1.json': new Uint8Array([0, 1, 2]),
      'JMdict/index.json': index('JMdict', '2024.01', { attribution: 'EDRDG', indexUrl: 'https://example.com/index.json' }),
    });
    const info = await t.dict.importZip({ bytes, fileName: 'jmdict.zip' });
    expect(info).toMatchObject({
      title: 'JMdict',
      revision: '2024.01',
      kind: 'mixed',
      status: 'ready',
      priority: 0,
      enabled: true,
      termCount: JM_TERMS.length,
      metaCount: JM_META.length,
      attribution: 'EDRDG',
      indexUrl: 'https://example.com/index.json',
      importedAt: t.clock.now,
    });
    expect(info.id).toMatch(/^dict_/);
    expect(await t.dict.list()).toEqual([info]);

    const db = await rawDb(t);
    const terms = await db.getAll('dictTerms', dictKeyRange(info.id));
    expect(terms.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(terms[0]).toMatchObject({ expression: '言う', reading: 'いう', keys: ['言う', 'いう'] });
    expect(terms.find((r) => r.expression === '見る')?.redirectTo).toBe('みる');
    expect(await db.getAllFromIndex('dictTerms', 'byKey', 'かける')).toHaveLength(1);
    const meta = await db.getAll('dictMeta', dictKeyRange(info.id));
    expect(meta.map((m) => `${m.expression}:${m.mode}`).sort()).toEqual(['言う:freq', '賭ける:freq', '賭ける:pitch']);

    const ev = dictEvents(t.events);
    expect(ev.every((e) => e.dictId === info.id)).toBe(true);
    expect(ev[0]).toMatchObject({ phase: 'importing', processedRows: 0, title: 'jmdict' });
    expect(ev.at(-1)).toMatchObject({ phase: 'ready', title: 'JMdict', processedRows: JM_TERMS.length + JM_META.length });
  });

  it('streams across tiny chunk boundaries, flushes in batches and merges meta drained mid-bank', async () => {
    const readFileStream = async (path: string) => bytesToStream(await t.fs.readFile(path), 97);
    const t = await makeHost({ readFileStream });
    const N = 6_000;
    const terms: unknown[][] = [];
    for (let i = 0; i < N; i++) terms.push([`語${i}`, `ご${i}`, 'n', '', 0, [`第${i}のいみ——テスト`], i + 1, '']);
    const meta: unknown[][] = [['反復', 'freq', 1]];
    for (let i = 0; i < 3_000; i++) meta.push([`頻${i}`, 'freq', i]);
    meta.push(['反復', 'freq', 2]);
    const path = `${DATA_ROOT}/imports/big.zip`;
    await t.fs.writeFile(
      path,
      makeZip({ 'index.json': index('Big'), 'term_bank_1.json': terms.slice(0, 3_500), 'term_bank_2.json': terms.slice(3_500), 'term_meta_bank_1.json': meta }),
    );
    const info = await t.dict.importZip({ filePath: path });
    // 3,002 meta rows → 3,001 stored records (反復 merged).
    expect(info).toMatchObject({ title: 'Big', kind: 'mixed', termCount: N, metaCount: 3_001 });

    const db = await rawDb(t);
    expect(await db.count('dictTerms', dictKeyRange(info.id))).toBe(N);
    expect(await db.get('dictTerms', [info.id, N - 1])).toMatchObject({ expression: `語${N - 1}`, senses: [{ gloss: `第${N - 1}のいみ——テスト` }] });
    expect(await db.count('dictMeta', dictKeyRange(info.id))).toBe(3_001);
    const merged = await db.get('dictMeta', [info.id, '反復', 'freq']);
    expect(merged?.entries.map((e) => (e as { value: number }).value)).toEqual([1, 2]);
  });

  it('imports streaming-written zips (STORED entries with data descriptors)', async () => {
    const t = await makeHost();
    const bytes = makeDescriptorZip({ 'term_bank_1.json': JM_TERMS, 'index.json': index('Descriptor') });
    const info = await t.dict.importZip({ bytes });
    expect(info).toMatchObject({ title: 'Descriptor', kind: 'term', termCount: JM_TERMS.length });
    const db = await rawDb(t);
    expect(await db.count('dictTerms', dictKeyRange(info.id))).toBe(JM_TERMS.length);
  });

  it('retries in memory when the stream fails mid-archive, discarding rows from the failed pass', async () => {
    const meta: unknown[][] = [];
    for (let i = 0; i < 2_600; i++) meta.push([`頻${i}`, 'freq', i]);
    const terms: unknown[][] = [];
    for (let i = 0; i < 3_000; i++) terms.push([`語${i}`, '', 'n', '', 0, [`gloss ${i}`], 0, '']);
    const zip = makeZip({ 'term_meta_bank_1.json': meta, 'term_bank_1.json': terms, 'index.json': index('Flaky') });
    let opened = 0;
    const readFileStream = async (path: string): Promise<ReadableStream<Uint8Array>> => {
      opened += 1;
      const bytes = await t.fs.readFile(path);
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset > bytes.length * 0.8) {
            controller.error(new Error('stream reset'));
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + 512));
          offset += 512;
        },
      });
    };
    const t = await makeHost({ readFileStream });
    const path = `${DATA_ROOT}/imports/flaky.zip`;
    await t.fs.writeFile(path, zip);
    const info = await t.dict.importZip({ filePath: path });
    expect(opened).toBe(1);
    expect(info).toMatchObject({ title: 'Flaky', kind: 'mixed', termCount: 3_000, metaCount: 2_600 });
    const db = await rawDb(t);
    expect(await db.count('dictTerms', dictKeyRange(info.id))).toBe(3_000);
    expect(await db.count('dictMeta', dictKeyRange(info.id))).toBe(2_600);
    expect((await db.get('dictMeta', [info.id, '頻0', 'freq']))?.entries).toHaveLength(1);
  });

  it('blue-green re-import of the same title replaces the old dictionary and inherits priority / enabled', async () => {
    const t = await makeHost();
    const v1 = await t.dict.importZip({ bytes: jmZip('1') });
    const other = await t.dict.importZip({ bytes: makeZip({ 'index.json': index('Pitch'), 'term_meta_bank_1.json': JM_META.slice(0, 1) }) });
    expect(other).toMatchObject({ kind: 'pitch', priority: 1 });
    await expect(t.dict.update(v1.id, { priority: 5, enabled: false })).resolves.toMatchObject({ priority: 5, enabled: false });
    t.clock.now += 1_000;

    const v2 = await t.dict.importZip({ bytes: jmZip('2', JM_TERMS.slice(0, 3)) });
    expect(v2.id).not.toBe(v1.id);
    expect(v2).toMatchObject({ title: 'JMdict', revision: '2', priority: 5, enabled: false, termCount: 3 });
    expect((await t.dict.list()).map((d) => d.id)).toEqual([other.id, v2.id]);

    const db = await rawDb(t);
    expect(await db.get('dictionaries', v1.id)).toBeUndefined();
    expect(await db.count('dictTerms', dictKeyRange(v1.id))).toBe(0);
    expect(await db.count('dictMeta', dictKeyRange(v1.id))).toBe(0);
    expect(await db.count('dictTerms', dictKeyRange(v2.id))).toBe(3);
    expect(await db.count('dictMeta', dictKeyRange(other.id))).toBe(1);

    // A brand-new title goes after the current maximum priority.
    const third = await t.dict.importZip({ bytes: makeZip({ 'index.json': index('Third'), 'term_bank_1.json': JM_TERMS.slice(0, 1) }) });
    expect(third.priority).toBe(6);
  });

  it('downloads url / preset sources via downloadToFile into a temp file that is removed afterwards', async () => {
    const zip = jmZip();
    const seen: string[] = [];
    const t = await makeHost({
      downloadToFile: async (url, path, options) => {
        seen.push(url, path);
        options.onProgress(zip.length / 2, zip.length);
        await t.fs.writeFile(path, zip);
        options.onProgress(zip.length, zip.length);
      },
    });
    const info = await t.dict.importZip({ presetId: 'jmdict-en' });
    expect(seen[0]).toContain('JMdict_english.zip');
    expect(seen[1]).toBe(`${DATA_ROOT}/cache/dict/${info.id}.zip`);
    expect(await t.fs.stat(seen[1]!)).toBeUndefined();
    expect(info).toMatchObject({ title: 'JMdict', sourceUrl: seen[0], indexUrl: expect.stringContaining('JMdict_english.json'), attribution: expect.stringContaining('EDRDG') });
    const ev = dictEvents(t.events);
    expect(ev[0]).toMatchObject({ phase: 'downloading', title: 'JMdict (English)', processedRows: 0 });
    expect(ev.filter((e) => e.phase === 'downloading').every((e) => e.processedRows === 0)).toBe(true);
    expect(ev.at(-1)?.phase).toBe('ready');

    await expect(t.dict.importZip({ presetId: 'nope' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(t.dict.importZip({})).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('falls back to fetch for url sources without downloadToFile', async () => {
    const zip = jmZip();
    const t = await makeHost({
      fetch: (async (url: string) => (url.endsWith('ok.zip') ? new Response(zip.slice()) : new Response('nope', { status: 404 }))) as typeof fetch,
    });
    const info = await t.dict.importZip({ url: 'https://example.com/ok.zip', attribution: 'mine' });
    expect(info).toMatchObject({ title: 'JMdict', sourceUrl: 'https://example.com/ok.zip', attribution: 'mine', termCount: JM_TERMS.length });
    await expect(t.dict.importZip({ url: 'https://example.com/missing.zip' })).rejects.toMatchObject({ code: 'network' });
    expect((await t.dict.list()).map((d) => d.id)).toEqual([info.id]);
  });

  it.each([
    ['no index.json', () => makeZip({ 'term_bank_1.json': JM_TERMS })],
    ['invalid index.json', () => makeZip({ 'term_bank_1.json': JM_TERMS, 'index.json': strToU8('{"title": "x",') })],
    ['corrupt term bank JSON', () => makeZip({ 'index.json': index('Broken'), 'term_bank_1.json': strToU8('[["a","a","",""," broken,') })],
    ['not a zip', () => strToU8('definitely not a zip archive')],
  ])('failed import (%s) leaves nothing behind', async (_label, build) => {
    const t = await makeHost();
    const keep = await t.dict.importZip({ bytes: jmZip() });
    await expect(t.dict.importZip({ bytes: build(), fileName: 'bad.zip' })).rejects.toMatchObject({ name: 'KotoriError' });
    const db = await rawDb(t);
    expect((await db.getAll('dictionaries')).map((d) => d.id)).toEqual([keep.id]);
    expect(await db.count('dictTerms')).toBe(JM_TERMS.length);
    expect(await db.count('dictMeta')).toBe(3);
    const failed = dictEvents(t.events).at(-1);
    expect(failed).toMatchObject({ phase: 'failed', title: 'bad' });
    expect(failed?.error).toBeTruthy();
  });
});

describe('dict.remove / update / purgeIncompleteImports', () => {
  it('remove range-deletes one dictionary and leaves the other intact', async () => {
    const t = await makeHost();
    const a = await t.dict.importZip({ bytes: jmZip() });
    const b = await t.dict.importZip({ bytes: makeZip({ 'index.json': index('Other'), 'term_bank_1.json': JM_TERMS, 'term_meta_bank_1.json': JM_META }) });
    await t.dict.remove(a.id);
    expect((await t.dict.list()).map((d) => d.id)).toEqual([b.id]);
    const db = await rawDb(t);
    expect(await db.count('dictTerms', dictKeyRange(a.id))).toBe(0);
    expect(await db.count('dictMeta', dictKeyRange(a.id))).toBe(0);
    expect(await db.count('dictTerms')).toBe(JM_TERMS.length);
    expect(await db.count('dictMeta')).toBe(3);
    await expect(t.dict.remove('missing')).rejects.toMatchObject({ code: 'not-found' });
    await expect(t.dict.update('missing', { enabled: false })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('host startup purges importing dictionaries (rows + temp downloads) but keeps ready ones', async () => {
    const first = await makeHost();
    const ready = await first.dict.importZip({ bytes: jmZip() });
    const db = await rawDb(first);
    const stale = 'dict_stale';
    await db.put('dictionaries', { ...ready, id: stale, title: 'Half', status: 'importing' });
    await db.put('dictTerms', { ...(await db.get('dictTerms', [ready.id, 0]))!, dictId: stale, seq: 0 });
    await db.put('dictMeta', { dictId: stale, expression: '賭ける', mode: 'freq', entries: [{ value: 1, displayValue: '1' }] });
    await first.fs.writeFile(`${DATA_ROOT}/cache/dict/${stale}.zip`, new Uint8Array([1, 2, 3]));
    db.close();
    dbs.splice(dbs.indexOf(db), 1);
    await first.host.dispose();
    open.splice(open.indexOf(first), 1);

    const second = await makeHost({}, { fs: first.fs, idbFactory: first.idbFactory, clock: first.clock });
    expect((await second.dict.list()).map((d) => d.id)).toEqual([ready.id]);
    const db2 = await rawDb(second);
    expect(await db2.get('dictionaries', stale)).toBeUndefined();
    expect(await db2.count('dictTerms', dictKeyRange(stale))).toBe(0);
    expect(await db2.count('dictMeta', dictKeyRange(stale))).toBe(0);
    expect(await db2.count('dictTerms', dictKeyRange(ready.id))).toBe(JM_TERMS.length);
    expect(await second.fs.stat(`${DATA_ROOT}/cache/dict/${stale}.zip`)).toBeUndefined();
    // Importing rows are invisible to list() even before purge.
    expect((await second.dict.list()).some((d) => d.status !== 'ready')).toBe(false);
  });
});

describe('dict lookups', () => {
  it('enrichVocab: exact kanji match with pitch / freq, redirect following, disabled dicts ignored', async () => {
    const t = await makeHost();
    const jm = await t.dict.importZip({ bytes: jmZip() });
    const out = await t.dict.enrichVocab([vocab('v0', '賭ける', 'かける', 'verb', 'to bet'), vocab('v1', '見る', 'みる', 'verb', '看'), vocab('v2', '橋', 'はし', 'noun', '桥')]);
    expect(out['v0']).toMatchObject({ status: 'matched', headword: '賭ける', senseGroups: [{ dictId: jm.id, dictTitle: 'JMdict', expression: '賭ける' }] });
    expect(out['v0']?.frequencies).toEqual([{ dictId: jm.id, dictTitle: 'JMdict', value: 3851, displayValue: '3851' }]);
    expect(out['v0']?.pitches[0]).toMatchObject({ reading: 'かける', position: 2, sources: ['JMdict'] });
    expect(out['v1']).toMatchObject({ status: 'matched', headword: '見る', senseGroups: [{ expression: 'みる', senses: [{ gloss: '看，观看' }] }] });
    expect(out['v2']?.status).toBe('empty');

    await t.dict.update(jm.id, { enabled: false });
    expect((await t.dict.enrichVocab([vocab('v0', '賭ける', 'かける', 'verb', 'to bet')]))['v0']?.status).toBe('empty');
  });

  it('lookupPrefix deinflects 言っちゃった → 言う and 食べさせられなかった → 食べる', async () => {
    const t = await makeHost();
    await t.dict.importZip({ bytes: jmZip() });
    const iu = await t.dict.lookupPrefix('言っちゃったんだよ');
    expect(iu[0]).toMatchObject({ surface: '言っちゃった', matchedLength: 6, lemma: '言う', reading: 'いう' });
    expect(iu[0]?.frequencies.map((f) => f.value)).toEqual([30]);
    expect(iu.findIndex((m) => m.lemma === '言')).toBeGreaterThan(0);
    const taberu = await t.dict.lookupPrefix('食べさせられなかった。');
    expect(taberu[0]).toMatchObject({ lemma: '食べる', reading: 'たべる', matchedLength: 10 });
    expect((await t.dict.lookupPrefix('見てた'))[0]).toMatchObject({ lemma: 'みる', matchedLength: 3 });
    expect((await t.dict.lookupPrefix('食べさせられなかった', 2)).every((m) => m.matchedLength <= 2)).toBe(true);
  });

  it('returns nothing with no dictionaries installed', async () => {
    const t = await makeHost();
    expect(await t.dict.lookupPrefix('言う')).toEqual([]);
    expect(await t.dict.enrichVocab([vocab('v0', '言う', 'いう', 'verb', 'say')])).toEqual({ v0: { status: 'empty', pitches: [], frequencies: [], senseGroups: [] } });
  });
});
