import { describe, expect, it } from 'vitest';
import type { CompactTermRecord, DictionaryInfo } from '../types';
import { scanPrefixDeinflections } from './clean-deinflector';
import { buildEnrichContext, type DictionaryLookupSource } from './disambiguate';
import { buildInstantLookupMatches, lookupPrefixBatch } from './instant-lookup';
import { MetaRowAccumulator, parseYomitanMetaRow, parseYomitanTermRow, type DictMetaRecord } from './yomitan-parser';

const DICTS: DictionaryInfo[] = [
  { id: 'wty', title: 'Wiktionary 日中', revision: '1', kind: 'term', status: 'ready', priority: 0, enabled: true, termCount: 0, metaCount: 0, importedAt: 0 },
  { id: 'jm', title: 'JMdict', revision: '1', kind: 'term', status: 'ready', priority: 1, enabled: true, termCount: 0, metaCount: 0, importedAt: 0 },
  { id: 'jpdb', title: 'JPDB', revision: '1', kind: 'freq', status: 'ready', priority: 2, enabled: true, termCount: 0, metaCount: 0, importedAt: 0 },
];

let seq = 0;
const t = (dictId: string, row: unknown[]): CompactTermRecord => parseYomitanTermRow(row, dictId, seq++)!;

const TERMS: CompactTermRecord[] = [
  t('wty', ['言う', '', 'v godan vt', '', 0, ['说，讲'], 0, '']),
  t('jm', ['言う', 'いう', 'v5u vt', 'v5', 0, ['to say'], 1, '']),
  t('jm', ['言', 'げん', 'n', '', 0, ['word; remark'], 2, '']),
  t('wty', ['食べる', '', 'v ichidan vt', '', 0, ['吃'], 0, '']),
  t('jm', ['分かる', 'わかる', 'v5r vi', 'v5', 0, ['to understand'], 3, '']),
  t('wty', ['見る', '', 'non-lemma', '', 0, [['みる', ['alternative kanji']]], 0, '']),
  t('wty', ['みる', '', 'v ichidan vt', '', 0, ['看'], 0, '']),
];

const acc = new MetaRowAccumulator('jpdb');
acc.add(parseYomitanMetaRow(['言う', 'freq', { reading: 'いう', frequency: { value: 30, displayValue: '30' } }])!);
const META: DictMetaRecord[] = acc.drain();

function source(): DictionaryLookupSource & { termCalls: number } {
  const s = {
    dictionaries: DICTS,
    termCalls: 0,
    findTerms: async (keys: readonly string[]) => {
      s.termCalls++;
      return TERMS.filter((r) => r.keys.some((k) => keys.includes(k)));
    },
    findMeta: async (exprs: readonly string[]) => META.filter((m) => exprs.includes(m.expression)),
  };
  return s;
}

describe('buildInstantLookupMatches', () => {
  it('returns the longest deinflected match first with its chain, pitch/freq and senses', () => {
    const ctx = buildEnrichContext(DICTS, TERMS, META);
    const matches = buildInstantLookupMatches(scanPrefixDeinflections('言っちゃったんだよ'), ctx);
    const first = matches[0]!;
    expect(first).toMatchObject({ surface: '言っちゃった', matchedLength: 6, lemma: '言う', reading: 'いう' });
    expect(first.deinflectChain.length).toBeGreaterThanOrEqual(2);
    expect(first.frequencies.map((f) => f.value)).toEqual([30]);
    expect(first.senseGroups.map((g) => g.dictId)).toEqual(['wty', 'jm']);
    // Shorter fallbacks (the noun 言) come later; POS filter rejects verb-derived noun candidates.
    expect(matches.findIndex((m) => m.lemma === '言')).toBeGreaterThan(0);
    expect(matches.every((m) => m.matchedLength <= 6)).toBe(true);
  });

  it('matches kana prefixes through readings and follows redirects', () => {
    const ctx = buildEnrichContext(DICTS, TERMS, META);
    expect(buildInstantLookupMatches(scanPrefixDeinflections('わかんないよ'), ctx)[0]).toMatchObject({ lemma: '分かる', reading: 'わかる', matchedLength: 5 });
    const ctx2 = buildEnrichContext(DICTS, TERMS, META);
    const mi = buildInstantLookupMatches(scanPrefixDeinflections('見てた'), ctx2)[0];
    expect(mi).toMatchObject({ lemma: 'みる', matchedLength: 3, senseGroups: [{ expression: 'みる', senses: [{ gloss: '看' }] }] });
  });
});

describe('lookupPrefixBatch', () => {
  it('fetches every candidate stem in one query (+1 for redirect targets)', async () => {
    const src = source();
    const out = await lookupPrefixBatch('食べさせられなかった。', src);
    expect(out[0]).toMatchObject({ lemma: '食べる', matchedLength: 10 });
    expect(src.termCalls).toBe(1);
    const src2 = source();
    const mi = await lookupPrefixBatch('見る', src2);
    expect(mi[0]).toMatchObject({ lemma: 'みる', matchedLength: 2 });
    expect(src2.termCalls).toBe(2); // redirect target みる fetched in round 2
  });

  it('returns nothing without usable dictionaries or text', async () => {
    expect(await lookupPrefixBatch('', source())).toEqual([]);
    expect(await lookupPrefixBatch('言う', { ...source(), dictionaries: [] })).toEqual([]);
  });
});
