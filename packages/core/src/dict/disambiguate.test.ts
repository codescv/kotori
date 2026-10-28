import { describe, expect, it } from 'vitest';
import type { CompactTermRecord, DictionaryInfo, PartOfSpeech, VocabEntry } from '../types';
import {
  buildEnrichContext,
  enrichSingleVocab,
  enrichVocabBatch,
  lookupFrequencies,
  mergeIdenticalPitchGroups,
  posCompatible,
  scoreMeaningOverlap,
  termPosClasses,
  type DictionaryLookupSource,
} from './disambiguate';
import { MetaRowAccumulator, parseYomitanMetaRow, parseYomitanTermRow, type DictMetaRecord } from './yomitan-parser';

function dict(id: string, title: string, priority: number, kind: DictionaryInfo['kind'], extra: Partial<DictionaryInfo> = {}): DictionaryInfo {
  return { id, title, revision: '1', kind, status: 'ready', priority, enabled: true, termCount: 0, metaCount: 0, importedAt: 0, ...extra };
}

const DICTS: DictionaryInfo[] = [
  dict('wty', 'Wiktionary 日中', 0, 'term'),
  dict('jm', 'JMdict', 1, 'term'),
  dict('jit', 'Jitendex', 2, 'term'),
  dict('kanjium', 'Kanjium', 3, 'pitch'),
  dict('nhk', 'NHK', 4, 'pitch'),
  dict('jpdb', 'JPDBv2㋕', 5, 'freq'),
  dict('off', 'Disabled', 6, 'term', { enabled: false }),
  dict('half', 'Half imported', 7, 'term', { status: 'importing' }),
];

let seq = 0;
function term(dictId: string, row: unknown[]): CompactTermRecord {
  const rec = parseYomitanTermRow(row, dictId, seq++);
  if (!rec) throw new Error(`bad row ${JSON.stringify(row)}`);
  return rec;
}

const TERMS: CompactTermRecord[] = [
  // wty-ja-zh: empty readings, kana main entries, redirects.
  term('wty', ['見る', '', 'non-lemma', '', 0, [['みる', ['alternative kanji']]], 0, '']),
  term('wty', ['みる', '', 'v ichidan vt', '', 0, ['看，观看'], 0, '']),
  term('wty', ['わかる', '', 'v godan vi', '', 0, ['懂，明白，理解'], 0, '']),
  term('wty', ['賭ける', '', 'v ichidan vt', '', 0, ['賭博，打賭，押注', '押上，拼上'], 0, '']),
  term('wty', ['掛ける', '', 'v ichidan vt', '', 0, ['挂，悬挂', '花费'], 0, '']),
  term('wty', ['掛ける', '', 'suf', '', 0, ['（接动词连用形后）刚要……'], 0, '']),
  term('wty', ['逢う', '', 'non-lemma', '', 0, [['会う', ['alternative kanji']]], 0, '']),
  term('wty', ['会う', '', 'v godan vi', '', 0, ['见面，遇见'], 0, '']),
  // JMdict (English): canonical readings + sequence ids.
  term('jm', ['分かる', 'わかる', 'v5r vi', 'v5', 0, ['to understand; to comprehend'], 1001, '']),
  term('jm', ['賭ける', 'かける', 'v1 vt', 'v1', 0, ['to wager; to bet; to risk'], 2001, '']),
  term('jm', ['掛ける', 'かける', 'v1 vt', 'v1', 0, ['to hang up; to suspend'], 2002, '']),
  term('jm', ['駆ける', 'かける', 'v1 vi', 'v1', 0, ['to run; to dash'], 2003, '']),
  term('jm', ['欠ける', 'かける', 'v1 vi', 'v1', 0, ['to be chipped; to be lacking'], 2004, '']),
  term('jm', ['箸', 'はし', 'n', '', 0, ['chopsticks'], 3001, '']),
  term('jm', ['端', 'はし', 'n', '', 0, ['end; edge'], 3002, '']),
  term('jm', ['矢っ張り', 'やっぱり', 'adv', '', 0, ['as expected'], 4001, '']),
  // Jitendex: an alternative spelling sharing JMdict sequence 1001.
  term('jit', ['解る', 'わかる', 'v5r vi', 'v5', 0, ['to understand (alt. spelling)'], 1001, '']),
  // Unusable dictionaries must be ignored.
  term('off', ['橋', 'はし', 'n', '', 0, ['bridge (disabled dict)'], 0, '']),
  term('half', ['橋', 'はし', 'n', '', 0, ['bridge (half imported)'], 0, '']),
];

function meta(dictId: string, rows: unknown[][]): DictMetaRecord[] {
  const acc = new MetaRowAccumulator(dictId);
  for (const r of rows) {
    const p = parseYomitanMetaRow(r);
    if (p) acc.add(p);
  }
  return acc.drain();
}

const META: DictMetaRecord[] = [
  ...meta('kanjium', [
    ['賭ける', 'pitch', { reading: 'かける', pitches: [{ position: 2 }] }],
    ['掛ける', 'pitch', { reading: 'かける', pitches: [{ position: 2 }] }],
    ['欠ける', 'pitch', { reading: 'かける', pitches: [{ position: 0 }] }],
    ['見る', 'pitch', { reading: 'みる', pitches: [{ position: 1 }] }],
  ]),
  ...meta('nhk', [
    ['賭ける', 'pitch', { reading: 'かける', pitches: [{ position: 2 }, { position: 2, nasal: [2] }] }],
    ['見る', 'pitch', { reading: 'みる', pitches: [{ position: 1, devoice: [1] }] }],
  ]),
  ...meta('jpdb', [
    ['賭ける', 'freq', { reading: 'かける', frequency: { value: 3851, displayValue: '3851' } }],
    ['掛ける', 'freq', { reading: 'かける', frequency: { value: 2055, displayValue: '2055' } }],
    ['掛ける', 'freq', { reading: 'かける', frequency: { value: 202, displayValue: '202㋕' } }],
    ['かける', 'freq', { value: 202, displayValue: '202㋕' }],
    ['分かる', 'freq', { reading: 'わかる', frequency: { value: 50, displayValue: '50' } }],
  ]),
];

const CTX = buildEnrichContext(DICTS, TERMS, META);

function v(lemma: string, lemmaReading: string, partOfSpeech: PartOfSpeech, meaning: string): Pick<VocabEntry, 'lemma' | 'lemmaReading' | 'partOfSpeech' | 'meaning'> {
  return { lemma, lemmaReading, partOfSpeech, meaning };
}

describe('pitch & frequency (R1 / M5 / M7)', () => {
  it('merges pitch rows only on identical full payload, keeping every source', () => {
    expect(
      mergeIdenticalPitchGroups([
        { reading: 'かける', pattern: { position: 2 }, source: 'A' },
        { reading: 'かける', pattern: { position: 2 }, source: 'B' },
        { reading: 'かける', pattern: { position: 2, nasal: [2] }, source: 'B' },
        { reading: 'かける', pattern: { position: 2, nasal: [] }, source: 'C' },
        { reading: 'かける', pattern: { position: 0 }, source: 'A' },
        { reading: 'かける', pattern: { position: 2 }, source: 'A' },
      ]),
    ).toEqual([
      { reading: 'かける', position: 2, sources: ['A', 'B', 'C'] },
      { reading: 'かける', position: 2, nasal: [2], sources: ['B'] },
      { reading: 'かける', position: 0, sources: ['A'] },
    ]);
  });

  it('賭ける gets exactly its own JPDB #3851 and never the bare かける 202㋕ row', () => {
    const e = enrichSingleVocab(v('賭ける', 'かける', 'verb', '赌上，押上'), CTX);
    expect(e.frequencies).toEqual([{ dictId: 'jpdb', dictTitle: 'JPDBv2㋕', value: 3851, displayValue: '3851' }]);
    expect(e.frequencies.some((f) => f.kanaOnly)).toBe(false);
    expect(e.pitches).toEqual([
      { reading: 'かける', position: 2, sources: ['Kanjium', 'NHK'] },
      { reading: 'かける', position: 2, nasal: [2], sources: ['NHK'] },
    ]);
  });

  it('掛ける accepts its own exact-pair ㋕ row; kana lemma かける reads the bare kana row', () => {
    expect(lookupFrequencies(CTX, '掛ける', 'かける').map((f) => f.displayValue)).toEqual(['2055', '202㋕']);
    expect(lookupFrequencies(CTX, 'かける', 'かける')).toEqual([{ dictId: 'jpdb', dictTitle: 'JPDBv2㋕', value: 202, displayValue: '202㋕', kanaOnly: true }]);
    // Reading mismatch → nothing.
    expect(lookupFrequencies(CTX, '賭ける', 'かけ')).toEqual([]);
  });

  it('pitch lookup is keyed by the AI lemma even when senses come from a redirect', () => {
    const e = enrichSingleVocab(v('見る', 'ミル', 'verb', '看'), CTX);
    expect(e.pitches).toEqual([
      { reading: 'みる', position: 1, sources: ['Kanjium'] },
      { reading: 'みる', position: 1, devoice: [1], sources: ['NHK'] },
    ]);
  });
});

describe('sense lookup (steps 1–2)', () => {
  it('step 1: exact kanji hit across dictionaries, highlighting the matching sense', () => {
    const e = enrichSingleVocab(v('賭ける', 'かける', 'verb', '赌上，押上'), CTX);
    expect(e.status).toBe('matched');
    expect(e.headword).toBe('賭ける');
    expect(e.reading).toBe('かける');
    expect(e.senseGroups.map((g) => [g.dictId, g.expression])).toEqual([
      ['wty', '賭ける'],
      ['jm', '賭ける'],
    ]);
    expect(e.senseGroups[0]?.senses.map((s) => s.gloss)).toEqual(['赌博，打赌，押注', '押上，拼上']);
    expect(e.senseGroups[0]?.matchedSenseIdx).toBe(1);
    expect(e.senseGroups[1]?.matchedSenseIdx).toBeUndefined();
  });

  it('step 1: one-hop redirect 見る → みる', () => {
    const e = enrichSingleVocab(v('見る', 'みる', 'verb', '看'), CTX);
    expect(e.status).toBe('matched');
    expect(e.headword).toBe('見る');
    expect(e.senseGroups).toEqual([{ dictId: 'wty', dictTitle: 'Wiktionary 日中', expression: 'みる', reading: 'みる', defTags: 'v ichidan vt', senses: [{ gloss: '看，观看' }] }]);
  });

  it('step 2: 分かる safely falls back to the pure-kana わかる in wty while JMdict hits exactly', () => {
    const e = enrichSingleVocab(v('分かる', 'わかる', 'verb', '明白'), CTX);
    expect(e.status).toBe('matched');
    expect(e.senseGroups.map((g) => [g.dictId, g.expression])).toEqual([
      ['wty', 'わかる'],
      ['jm', '分かる'],
      // Same JMdict entry (sequence 1001, same reading) → verified alternative spelling.
      ['jit', '解る'],
    ]);
    expect(e.frequencies.map((f) => f.value)).toEqual([50]);
  });

  it('step 2: Orthography Guard never lets 箸 / 端 stand in for a missing 橋 (and ignores unusable dicts)', () => {
    const e = enrichSingleVocab(v('橋', 'はし', 'noun', '桥'), CTX);
    expect(e.status).toBe('empty');
    expect(e.senseGroups).toEqual([]);
    expect(e.candidates).toBeUndefined();
  });

  it('step 2: accepts another kanji spelling only through a verified shared sequence id', () => {
    const e = enrichSingleVocab(v('解る', 'わかる', 'verb', '理解'), CTX);
    expect(e.status).toBe('matched');
    expect(e.senseGroups.map((g) => [g.dictId, g.expression]).sort()).toEqual([
      ['jit', '解る'],
      ['jm', '分かる'],
      ['wty', 'わかる'],
    ]);
  });

  it('kana lemma with a single kanji homograph family merges into one match', () => {
    const e = enrichSingleVocab(v('やっぱり', 'やっぱり', 'adverb', '果然'), CTX);
    expect(e.status).toBe('matched');
    expect(e.headword).toBe('矢っ張り');
    expect(e.senseGroups.map((g) => g.expression)).toEqual(['矢っ張り']);
  });
});

describe('POS filter (step 3)', () => {
  it('maps JMdict and wty tag families', () => {
    expect([...termPosClasses({ defTags: 'v ichidan vt', rules: '' })]).toEqual(['verb']);
    expect([...termPosClasses({ defTags: 'adj_noun', rules: '' })]).toEqual(['na-adj']);
    expect([...termPosClasses({ defTags: 'adj', rules: '' })]).toEqual(['i-adj']);
    expect([...termPosClasses({ defTags: 'n vs', rules: 'vs' })].sort()).toEqual(['noun', 'verb']);
    expect([...termPosClasses({ defTags: 'v5k-s', rules: 'v5' })]).toEqual(['verb']);
    expect(termPosClasses({ defTags: 'non-lemma', rules: '' }).size).toBe(0);
    const suf = TERMS.find((t) => t.defTags === 'suf')!;
    expect(posCompatible(suf, 'verb')).toBe(false);
    expect(posCompatible(suf, 'suffix')).toBe(true);
    expect(posCompatible(suf, 'expression')).toBe(true);
  });

  it('keeps only verb records for a verb, suf for a suffix, and falls back softly when it would empty', () => {
    const verb = enrichSingleVocab(v('掛ける', 'かける', 'verb', '挂'), CTX);
    expect(verb.senseGroups.map((g) => [g.dictId, g.defTags])).toEqual([
      ['wty', 'v ichidan vt'],
      ['jm', 'v1 vt'],
    ]);
    const suffix = enrichSingleVocab(v('掛ける', 'かける', 'suffix', '刚要'), CTX);
    expect(suffix.senseGroups.map((g) => g.defTags)).toEqual(['suf']);
    const adverb = enrichSingleVocab(v('掛ける', 'かける', 'adverb', 'x'), CTX);
    expect(adverb.senseGroups).toHaveLength(3);
  });
});

describe('overlap scoring + confidence gate (step 4)', () => {
  it('scores Simplified-normalised bigrams and characters', () => {
    expect(scoreMeaningOverlap('赌上，押上', '押上，拼上')).toBe(20);
    expect(scoreMeaningOverlap('賭博', '赌博')).toBe(20);
    expect(scoreMeaningOverlap('豁出去', '赌博，打赌，押注')).toBe(0);
    expect(scoreMeaningOverlap('to bet money', 'to wager; to bet')).toBe(10);
  });

  it('kana lemma かける with a paraphrased meaning stays explicitly uncertain', () => {
    const e = enrichSingleVocab(v('かける', 'かける', 'verb', '豁出去，拼一把'), CTX);
    expect(e.status).toBe('uncertain');
    expect(e.headword).toBe('かける');
    expect(e.senseGroups).toEqual([]);
    expect(e.frequencies).toEqual([{ dictId: 'jpdb', dictTitle: 'JPDBv2㋕', value: 202, displayValue: '202㋕', kanaOnly: true }]);
    const c = e.candidates ?? [];
    expect(c.map((x) => x.expression).sort()).toEqual(['掛ける', '欠ける', '賭ける', '駆ける'].sort());
    const kake = c.find((x) => x.expression === '賭ける');
    expect(kake?.frequencies.map((f) => f.displayValue)).toEqual(['3851']);
    expect(kake?.pitches[0]).toMatchObject({ position: 2 });
    expect(c.find((x) => x.expression === '欠ける')?.pitches[0]).toMatchObject({ position: 0 });
  });

  it('kana lemma かける with a clearly overlapping meaning passes the gate', () => {
    const e = enrichSingleVocab(v('かける', 'かける', 'verb', 'to wager, to bet'), CTX);
    expect(e.status).toBe('matched');
    expect(e.headword).toBe('賭ける');
    expect(e.senseGroups[0]).toMatchObject({ dictId: 'jm', expression: '賭ける', matchedSenseIdx: 0 });
    // Pitch: none recorded for kana かける → falls back to the matched headword's exact pair.
    expect(e.pitches[0]).toMatchObject({ reading: 'かける', position: 2 });
    // Frequency stays the kana spelling's own row.
    expect(e.frequencies.map((f) => f.displayValue)).toEqual(['202㋕']);
  });

  it('ties below the margin stay uncertain', () => {
    const e = enrichSingleVocab(v('かける', 'かける', 'verb', 'to run, to hang'), CTX);
    expect(e.status).toBe('uncertain');
  });
});

describe('enrichVocabBatch', () => {
  function source(dicts: readonly DictionaryInfo[] = DICTS): DictionaryLookupSource & { calls: string[] } {
    const calls: string[] = [];
    return {
      dictionaries: dicts,
      calls,
      findTerms: async (keys) => {
        calls.push(`terms:${[...keys].sort().join(',')}`);
        return TERMS.filter((t) => t.keys.some((k) => keys.includes(k)));
      },
      findMeta: async (exprs) => {
        calls.push(`meta:${exprs.length}`);
        return META.filter((m) => exprs.includes(m.expression));
      },
    };
  }

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

  it('enriches a batch in two batched rounds, resolving redirects fetched in round 2', async () => {
    const src = source();
    const out = await enrichVocabBatch(
      [vocab('v0', '賭ける', 'かける', 'verb', '赌上，押上'), vocab('v1', '逢う', 'あう', 'verb', '见面'), vocab('v2', 'かける', 'かける', 'verb', '豁出去'), vocab('v3', '橋', 'はし', 'noun', '桥')],
      src,
    );
    expect(src.calls.filter((c) => c.startsWith('terms:'))).toHaveLength(2);
    expect(src.calls.filter((c) => c.startsWith('meta:'))).toHaveLength(2);
    expect(src.calls[0]).toBe('terms:あう,かける,はし,橋,賭ける,逢う');
    expect(out['v0']?.status).toBe('matched');
    expect(out['v0']?.frequencies.map((f) => f.value)).toEqual([3851]);
    expect(out['v1']).toMatchObject({ status: 'matched', senseGroups: [{ expression: '会う', senses: [{ gloss: '见面，遇见' }] }] });
    expect(out['v2']?.status).toBe('uncertain');
    expect(out['v2']?.candidates?.find((c) => c.expression === '賭ける')?.frequencies[0]?.value).toBe(3851);
    expect(out['v3']?.status).toBe('empty');
  });

  it('returns empty enrichments without querying when no dictionary is usable', async () => {
    const src = source([dict('x', 'X', 0, 'term', { enabled: false })]);
    const out = await enrichVocabBatch([vocab('v0', '賭ける', 'かける', 'verb', 'x')], src);
    expect(out).toEqual({ v0: { status: 'empty', pitches: [], frequencies: [], senseGroups: [] } });
    expect(src.calls).toEqual([]);
  });
});
