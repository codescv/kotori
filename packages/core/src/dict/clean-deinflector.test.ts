import { describe, expect, it } from 'vitest';
import {
  CLEAN_DEINFLECT_RULES,
  MAX_DEINFLECT_DEPTH,
  deinflect,
  scanPrefixDeinflections,
  wordClassesMatchTermRules,
  type Deinflection,
} from './clean-deinflector';

function find(word: string, term: string): Deinflection | undefined {
  return deinflect(word).find((d) => d.term === term);
}

describe('CLEAN_DEINFLECT_RULES', () => {
  it('is a well-formed table of the expected size', () => {
    expect(CLEAN_DEINFLECT_RULES.length).toBeGreaterThanOrEqual(120);
    for (const r of CLEAN_DEINFLECT_RULES) {
      expect(r.from.length).toBeGreaterThan(0);
      expect(r.inClasses.length).toBeGreaterThan(0);
      expect(r.outClasses.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate rules', () => {
    const keys = CLEAN_DEINFLECT_RULES.map((r) => `${r.from}|${r.to}|${r.inClasses.join(',')}|${r.reason}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('merges rules that only differ in output class', () => {
    const rerureru = CLEAN_DEINFLECT_RULES.find((r) => r.from === 'れる' && r.to === 'る' && r.reason === 'potential');
    expect(rerureru?.outClasses).toEqual(expect.arrayContaining(['v1', 'v5']));
  });
});

describe('deinflect', () => {
  it('returns the input first with no reasons', () => {
    const [first] = deinflect('食べる');
    expect(first).toEqual({ term: '食べる', wordClasses: [], reasons: [], path: ['食べる'] });
    expect(deinflect('')).toEqual([]);
  });

  it('言っちゃった → 言う via 言っちゃう', () => {
    const d = find('言っちゃった', '言う');
    expect(d?.path).toEqual(['言っちゃった', '言っちゃう', '言う']);
    expect(d?.wordClasses).toEqual(['v5']);
    expect(d?.reasons).toHaveLength(2);
  });

  it('食べさせられなかった → 食べる through every auxiliary', () => {
    const d = find('食べさせられなかった', '食べる');
    expect(d?.path).toEqual(['食べさせられなかった', '食べさせられない', '食べさせられる', '食べさせる', '食べる']);
    expect(d?.wordClasses).toContain('v1');
    expect(d?.reasons).toEqual(['past', 'negative', 'passive/potential', 'causative']);
  });

  it.each([
    // Colloquial contractions (R4).
    ['わかんない', 'わかる'],
    ['わかんねえ', 'わかる'],
    ['読んでる', '読む'],
    ['しとく', 'する'],
    ['行かなきゃ', '行く'],
    ['行かなくちゃ', '行く'],
    ['行かなけりゃ', '行く'],
    ['食べてた', '食べる'],
    ['飲んでた', '飲む'],
    ['知らねえ', '知る'],
    ['知らねぇ', '知る'],
    ['知らん', '知る'],
    ['すごくねえ', 'すごい'],
    ['やりゃ', 'やる'],
    ['高けりゃ', '高い'],
    ['見ちまった', '見る'],
    ['死んじゃった', '死ぬ'],
    ['泳いじゃう', '泳ぐ'],
    ['書いちゃう', '書く'],
    ['話しちゃった', '話す'],
    ['行っちゃった', '行く'],
    ['来ちゃった', '来る'],
    ['読んどく', '読む'],
    ['やっといた', 'やる'],
    ['言ってん', '言う'],
    ['言ってるん', '言う'],
    ['食べちゃだめ'.slice(0, 4), '食べる'],
    // Standard godan.
    ['行った', '行く'],
    ['行って', '行く'],
    ['言った', '言う'],
    ['待った', '待つ'],
    ['書いた', '書く'],
    ['泳いだ', '泳ぐ'],
    ['話した', '話す'],
    ['死んだ', '死ぬ'],
    ['遊んで', '遊ぶ'],
    ['読まない', '読む'],
    ['読みます', '読む'],
    ['読みませんでした', '読む'],
    ['読みたくない', '読む'],
    ['読めば', '読む'],
    ['読め', '読む'],
    ['読もう', '読む'],
    ['読める', '読む'],
    ['読まれる', '読む'],
    ['読ませる', '読む'],
    ['読まされた', '読む'],
    ['読まず', '読む'],
    ['読んだら', '読む'],
    // Ichidan.
    ['食べた', '食べる'],
    ['食べない', '食べる'],
    ['食べろ', '食べる'],
    ['食べよう', '食べる'],
    ['食べれる', '食べる'],
    ['食べたかった', '食べる'],
    // カ変.
    ['来なかった', '来る'],
    ['来た', '来る'],
    ['来られる', '来る'],
    ['来い', '来る'],
    ['こさせる', 'くる'],
    ['きます', 'くる'],
    // サ変.
    ['した', 'する'],
    ['しない', 'する'],
    ['される', 'する'],
    ['させる', 'する'],
    ['しろ', 'する'],
    ['せよ', 'する'],
    ['せず', 'する'],
    ['勉強した', '勉強する'],
    ['勉強した', '勉強'],
    ['勉強できる', '勉強する'],
    // Adjectives.
    ['高くなかった', '高い'],
    ['高かった', '高い'],
    ['高くて', '高い'],
    ['高ければ', '高い'],
    ['高く', '高い'],
    ['高さ', '高い'],
    ['高そう', '高い'],
    ['高すぎる', '高い'],
    ['よかった', 'いい'],
    // Honorific godan.
    ['くださいました', 'くださる'],
    ['いらっしゃい', 'いらっしゃる'],
  ])('%s → %s', (surface, lemma) => {
    const d = find(surface, lemma);
    expect(d, `${surface} → ${lemma}; got ${deinflect(surface).map((x) => x.term).join(',')}`).toBeDefined();
    expect(d?.path[0]).toBe(surface);
    expect(d?.path[d.path.length - 1]).toBe(lemma);
    expect(d?.reasons.length).toBe((d?.path.length ?? 1) - 1);
  });

  it('assigns the expected dictionary classes', () => {
    const classesOf = (w: string, t: string): string[] =>
      deinflect(w)
        .filter((d) => d.term === t)
        .flatMap((d) => [...d.wordClasses]);
    expect(find('行った', '行く')?.wordClasses).toEqual(['v5']);
    // 来ない also matches the generic ichidan rule (v1); the vk reading must be present.
    expect(classesOf('来なかった', '来る')).toContain('vk');
    expect(classesOf('しとく', 'する')).toEqual(['vs']);
    expect(find('高くなかった', '高い')?.wordClasses).toEqual(['adj-i']);
    expect(find('勉強した', '勉強')?.wordClasses).toEqual(['vs']);
  });

  it('only returns dictionary classes beyond the raw input', () => {
    for (const word of ['言っちゃった', '食べさせられなかった', 'わかんない', '行かなきゃ']) {
      const [, ...rest] = deinflect(word);
      for (const d of rest) {
        expect(d.wordClasses.length).toBeGreaterThan(0);
        for (const c of d.wordClasses) expect(['v1', 'v5', 'vk', 'vs', 'vz', 'adj-i']).toContain(c);
        expect(d.path.length).toBeLessThanOrEqual(MAX_DEINFLECT_DEPTH + 1);
      }
    }
  });

  it('dedupes by term + classes', () => {
    const results = deinflect('食べさせられなかった');
    const keys = results.map((d) => `${d.term}|${[...d.wordClasses].sort().join(',')}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stays bounded on long / repetitive input', () => {
    const results = deinflect('ないないないないないないないないないないないない');
    expect(results.length).toBeLessThan(2000);
  });

  it('does not chain rules whose input class does not match', () => {
    // 高くなかった → 高くない is `nai`; the ichidan negative rule (ない→る) needs `nai`
    // too, but the adjective-past branch (高くない as adj-i) must not feed it again.
    const viaAdj = deinflect('高くなかった').filter((d) => d.term === '高くる');
    expect(viaAdj.every((d) => d.path.length === 3 && d.path[1] === '高くない')).toBe(true);
    // A te-form (読んで) never takes a past-tense rule (んだ→む needs `ta`).
    expect(deinflect('読んでる').some((d) => d.reasons.includes('past'))).toBe(false);
  });

  it('handles い-dropping (食べてない = 食べていない)', () => {
    expect(find('食べてない', '食べる')?.path).toEqual(['食べてない', '食べてる', '食べて', '食べる']);
  });
});

describe('scanPrefixDeinflections', () => {
  it('finds 言う over 6 chars before shorter matches', () => {
    const results = scanPrefixDeinflections('言っちゃったんだよ');
    const idx = results.findIndex((r) => r.matchedLength === 6 && r.term === '言う');
    expect(idx).toBeGreaterThanOrEqual(0);
    const hit = results[idx];
    expect(hit?.surface).toBe('言っちゃった');
    expect(hit?.path).toEqual(['言っちゃった', '言っちゃう', '言う']);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.matchedLength < 6) expect(i).toBeGreaterThan(idx);
    }
  });

  it('orders candidates longest-first and dedupes by (term, matchedLength)', () => {
    const results = scanPrefixDeinflections('食べてたよね');
    for (let i = 1; i < results.length; i++) {
      expect(results[i]?.matchedLength ?? 0).toBeLessThanOrEqual(results[i - 1]?.matchedLength ?? 0);
    }
    const keys = results.map((r) => `${r.term}|${r.matchedLength}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(results.some((r) => r.term === '食べる' && r.matchedLength === 4)).toBe(true);
  });

  it('respects maxLength and handles edge cases', () => {
    const results = scanPrefixDeinflections('言っちゃったんだよ', 3);
    expect(Math.max(...results.map((r) => r.matchedLength))).toBe(3);
    expect(scanPrefixDeinflections('')).toEqual([]);
    expect(scanPrefixDeinflections('abc', 0)).toEqual([]);
  });

  it('reports matchedLength in UTF-16 units for astral characters', () => {
    const text = '𠮟った';
    const results = scanPrefixDeinflections(text);
    const hit = results.find((r) => r.term === '𠮟る');
    expect(hit).toBeDefined();
    expect(text.slice(0, hit?.matchedLength)).toBe(hit?.surface);
  });
});

describe('wordClassesMatchTermRules', () => {
  it('matches JMdict POS codes', () => {
    expect(wordClassesMatchTermRules(['v5'], 'v1')).toBe(false);
    expect(wordClassesMatchTermRules(['v1'], 'v1')).toBe(true);
    expect(wordClassesMatchTermRules(['v5'], 'v5k-s vi')).toBe(true);
    expect(wordClassesMatchTermRules(['v5'], 'v5aru')).toBe(true);
    expect(wordClassesMatchTermRules(['vs'], 'n vs')).toBe(true);
    expect(wordClassesMatchTermRules(['vs'], 'vs-i')).toBe(true);
    expect(wordClassesMatchTermRules(['vs'], 'n')).toBe(false);
    expect(wordClassesMatchTermRules(['vk'], 'vk')).toBe(true);
    expect(wordClassesMatchTermRules(['adj-i'], 'adj-ix')).toBe(true);
    expect(wordClassesMatchTermRules(['adj-i'], 'adj-na')).toBe(false);
    expect(wordClassesMatchTermRules(['v1', 'v5'], 'v5r')).toBe(true);
  });

  it('matches wty-ja-zh defTags', () => {
    expect(wordClassesMatchTermRules(['v1'], '', 'v ichidan vt')).toBe(true);
    expect(wordClassesMatchTermRules(['v5'], '', 'v ichidan vt')).toBe(false);
    expect(wordClassesMatchTermRules(['v5'], '', 'v godan vi')).toBe(true);
    expect(wordClassesMatchTermRules(['vs'], '', 'v suru')).toBe(true);
    expect(wordClassesMatchTermRules(['adj-i'], '', 'adj')).toBe(true);
    expect(wordClassesMatchTermRules(['v5'], '', 'v')).toBe(true);
    expect(wordClassesMatchTermRules(['adj-i'], '', 'v')).toBe(false);
  });

  it('rejects recognised non-matching POS and treats unknown POS as wildcard', () => {
    expect(wordClassesMatchTermRules(['v5'], '', 'n')).toBe(false);
    expect(wordClassesMatchTermRules(['v5'], '', '')).toBe(true);
    expect(wordClassesMatchTermRules(['v5'], '', '⭐ P common')).toBe(true);
    expect(wordClassesMatchTermRules([], 'n')).toBe(true);
  });
});
