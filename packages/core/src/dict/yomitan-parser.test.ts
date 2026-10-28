import { describe, expect, it } from 'vitest';
import {
  MetaRowAccumulator,
  extractCompactSenses,
  inferDictionaryKind,
  normalizeZipEntryPath,
  parseYomitanIndex,
  parseYomitanMetaRow,
  parseYomitanTermRow,
  pitchPatternToPosition,
} from './yomitan-parser';
import { hasKanji, isAllKana, katakanaToHiragana, normalizeZhScript, zhScriptTableSize } from './zh-script';

/** A wty-ja-zh style structured-content entry. */
function wtyGlossary(): unknown[] {
  return [
    {
      type: 'structured-content',
      content: [
        { tag: 'details', data: { content: 'details-entry-Etymology' }, content: [{ tag: 'summary', content: 'Etymology' }, { tag: 'div', content: '源自古日语。' }] },
        {
          tag: 'ol',
          data: { content: 'glosses' },
          content: [
            {
              tag: 'li',
              content: [
                { tag: 'span', data: { content: 'tag' }, content: '他動詞' },
                '賭博，打賭，押注',
                {
                  tag: 'div',
                  data: { content: 'extra-info' },
                  content: {
                    tag: 'div',
                    data: { content: 'example-sentence' },
                    content: [
                      { tag: 'div', data: { content: 'example-sentence-a' }, content: ['命を', { tag: 'ruby', content: ['賭', { tag: 'rt', content: 'か' }] }, 'けて戦う'] },
                      { tag: 'div', data: { content: 'example-sentence-b' }, content: '賭上性命戰鬥' },
                    ],
                  },
                },
              ],
            },
            { tag: 'li', content: ['押上，拼上'] },
          ],
        },
        { tag: 'div', data: { content: 'backlink' }, content: [{ tag: 'a', href: 'https://kaikki.org/', content: 'Kaikki' }] },
      ],
    },
  ];
}

describe('zh-script', () => {
  it('folds katakana and classifies kana / kanji', () => {
    expect(katakanaToHiragana('カケル')).toBe('かける');
    expect(isAllKana('わかる')).toBe(true);
    expect(isAllKana('ワカル')).toBe(true);
    expect(isAllKana('ラーメン')).toBe(true);
    expect(isAllKana('分かる')).toBe(false);
    expect(isAllKana('')).toBe(false);
    expect(hasKanji('取り戻す')).toBe(true);
    expect(hasKanji('とりもどす')).toBe(false);
  });

  it('normalizes Traditional to Simplified Chinese', () => {
    expect(zhScriptTableSize()).toBeGreaterThan(2000);
    expect(normalizeZhScript('飛翔')).toBe('飞翔');
    expect(normalizeZhScript('維持生計')).toBe('维持生计');
    expect(normalizeZhScript('賭博，打賭；說話、開門、東西、買賣、選擇')).toBe('赌博，打赌；说话、开门、东西、买卖、选择');
    expect(normalizeZhScript('已经是简体')).toBe('已经是简体');
    expect(normalizeZhScript('かける abc')).toBe('かける abc');
  });
});

describe('normalizeZipEntryPath', () => {
  it('routes banks and strips wrapper directories', () => {
    expect(normalizeZipEntryPath('index.json')).toEqual({ kind: 'index', bank: 0, name: 'index.json' });
    expect(normalizeZipEntryPath('MyDict/term_bank_12.json')).toEqual({ kind: 'term_bank', bank: 12, name: 'term_bank_12.json' });
    expect(normalizeZipEntryPath('a/b/term_meta_bank_3.json')).toEqual({ kind: 'term_meta_bank', bank: 3, name: 'term_meta_bank_3.json' });
    expect(normalizeZipEntryPath('Wrapper\\index.json')?.kind).toBe('index');
  });

  it('ignores macOS junk, directories and unused entries', () => {
    expect(normalizeZipEntryPath('__MACOSX/MyDict/._term_bank_1.json')).toBeNull();
    expect(normalizeZipEntryPath('__MACOSX/index.json')).toBeNull();
    expect(normalizeZipEntryPath('MyDict/._index.json')).toBeNull();
    expect(normalizeZipEntryPath('MyDict/.DS_Store')).toBeNull();
    expect(normalizeZipEntryPath('MyDict/')).toBeNull();
    expect(normalizeZipEntryPath('styles.css')).toBeNull();
    expect(normalizeZipEntryPath('tag_bank_1.json')).toBeNull();
    expect(normalizeZipEntryPath('kanji_bank_1.json')).toBeNull();
  });
});

describe('parseYomitanIndex', () => {
  it('parses v3 indexes and rejects unsupported ones', () => {
    expect(parseYomitanIndex({ title: 'wty-ja-zh', revision: '2026.10.22', format: 3, sequenced: false, isUpdatable: true, indexUrl: 'https://x/index.json', attribution: 'Wiktionary' })).toEqual({
      title: 'wty-ja-zh',
      revision: '2026.10.22',
      format: 3,
      sequenced: false,
      isUpdatable: true,
      indexUrl: 'https://x/index.json',
      attribution: 'Wiktionary',
    });
    expect(parseYomitanIndex({ title: 'Kanjium', revision: 'pitch1', version: 3 })?.format).toBe(3);
    expect(parseYomitanIndex({ title: 'Old', revision: 1, format: 1 })).toBeNull();
    expect(parseYomitanIndex({ revision: 'x', format: 3 })).toBeNull();
    expect(parseYomitanIndex(null)).toBeNull();
    expect(parseYomitanIndex([1])).toBeNull();
  });

  it('infers dictionary kind from counts', () => {
    expect(inferDictionaryKind({ terms: 10, pitch: 0, freq: 0 })).toBe('term');
    expect(inferDictionaryKind({ terms: 0, pitch: 5, freq: 0 })).toBe('pitch');
    expect(inferDictionaryKind({ terms: 0, pitch: 0, freq: 5 })).toBe('freq');
    expect(inferDictionaryKind({ terms: 1, pitch: 0, freq: 5 })).toBe('mixed');
  });
});

describe('parseYomitanTermRow', () => {
  it('Path 1: extracts wiktionary glosses + one example pair, strips etymology / backlinks, normalizes zh', () => {
    const rec = parseYomitanTermRow(['賭ける', 'かける', 'v ichidan vt', 'v1', 5, wtyGlossary(), 0, ''], 'wty', 7);
    expect(rec).toEqual({
      dictId: 'wty',
      seq: 7,
      expression: '賭ける',
      reading: 'かける',
      defTags: 'v ichidan vt',
      rules: 'v1',
      score: 5,
      sequenceId: 0,
      senses: [{ gloss: '赌博，打赌，押注', examples: [['命を賭けて戦う', '赌上性命战斗']], tags: ['他動詞'] }, { gloss: '押上，拼上' }],
      keys: ['賭ける', 'かける'],
    });
  });

  it('keeps Traditional glosses when normalization is disabled', () => {
    const rec = parseYomitanTermRow(['飛翔', '', '', '', 0, ['飛翔，飛行'], 0, ''], 'd', 0, false);
    expect(rec?.senses[0]?.gloss).toBe('飛翔，飛行');
    expect(parseYomitanTermRow(['飛翔', '', '', '', 0, ['飛翔，飛行'], 0, ''], 'd', 0)?.senses[0]?.gloss).toBe('飞翔，飞行');
  });

  it('detects pure [[formOf, [rules]]] redirects and empty readings', () => {
    const rec = parseYomitanTermRow(['見る', '', 'non-lemma', '', 0, [['みる', ['alternative kanji']]], 0, ''], 'wty', 1);
    expect(rec).toMatchObject({ expression: '見る', reading: '', redirectTo: 'みる', senses: [], keys: ['見る'] });
  });

  it('detects non-lemma rows linking to another headword', () => {
    const gl = [{ type: 'structured-content', content: ['「', { tag: 'a', href: '?query=%E3%81%BF%E3%82%8B&wildcards=off', content: 'みる' }, '」的另一種寫法'] }];
    const rec = parseYomitanTermRow(['観る', '', 'non-lemma', '', 0, gl, 0, ''], 'wty', 2);
    expect(rec?.redirectTo).toBe('みる');
    expect(rec?.senses[0]?.gloss).toBe('「みる」的另一种写法');
  });

  it('derives reading + keys for kana expressions', () => {
    const kana = parseYomitanTermRow(['ワカル', '', 'v godan', '', 0, ['懂'], 0, ''], 'd', 0);
    expect(kana).toMatchObject({ reading: 'わかる', keys: ['ワカル', 'わかる'] });
    const hira = parseYomitanTermRow(['わかる', '', 'v godan', '', 0, ['懂'], 0, ''], 'd', 0);
    expect(hira).toMatchObject({ reading: 'わかる', keys: ['わかる'] });
    const kat = parseYomitanTermRow(['分かる', 'ワカル', 'v5', 'v5', 0, ['to understand'], 1234, ''], 'd', 0);
    expect(kat).toMatchObject({ reading: 'わかる', sequenceId: 1234, keys: ['分かる', 'わかる'] });
  });

  it('Path 2: JMdict-style glossary lists become one sense each; generic blocks become lines', () => {
    const jm = [
      {
        type: 'structured-content',
        content: [
          { tag: 'div', data: { content: 'sense' }, content: [{ tag: 'span', data: { content: 'part-of-speech-info' }, content: 'Ichidan verb' }, { tag: 'ul', data: { content: 'glossary' }, content: [{ tag: 'li', content: 'to hang' }, { tag: 'li', content: 'to suspend' }] }] },
          { tag: 'div', data: { content: 'sense' }, content: [{ tag: 'ul', data: { content: 'glossary' }, content: [{ tag: 'li', content: 'to wager' }, { tag: 'li', content: 'to bet' }] }] },
        ],
      },
    ];
    expect(extractCompactSenses(jm)).toEqual([{ gloss: 'to hang; to suspend' }, { gloss: 'to wager; to bet' }]);

    const generic = [{ type: 'structured-content', content: [{ tag: 'div', content: ['第一义'] }, { tag: 'p', content: ['第二', { tag: 'b', content: '义' }] }, { tag: 'br' }, '第三义'] }];
    expect(extractCompactSenses(generic)).toEqual([{ gloss: '第一义' }, { gloss: '第二义' }, { gloss: '第三义' }]);
    expect(extractCompactSenses([{ type: 'text', text: 'plain text' }, 'string gloss', { type: 'image', path: 'x.png' }])).toEqual([{ gloss: 'plain text' }, { gloss: 'string gloss' }]);
  });

  it('caps senses at 6 and rejects malformed rows', () => {
    const many = Array.from({ length: 10 }, (_, i) => `义${i}`);
    expect(parseYomitanTermRow(['語', 'ご', '', '', 0, many, 0, ''], 'd', 0)?.senses).toHaveLength(6);
    expect(parseYomitanTermRow(['x'], 'd', 0)).toBeNull();
    expect(parseYomitanTermRow(null, 'd', 0)).toBeNull();
    expect(parseYomitanTermRow(['', '', '', '', 0, ['a'], 0, ''], 'd', 0)).toBeNull();
    expect(parseYomitanTermRow(['語', '', '', '', 0, [], 0, ''], 'd', 0)).toBeNull();
  });
});

describe('parseYomitanMetaRow', () => {
  it('parses pitch rows strictly (positions, patterns, nasal / devoice)', () => {
    expect(parseYomitanMetaRow(['賭ける', 'pitch', { reading: 'かける', pitches: [{ position: 2 }] }])).toEqual({ expression: '賭ける', mode: 'pitch', data: { reading: 'かける', pitches: [{ position: 2 }] } });
    expect(parseYomitanMetaRow(['飴', 'pitch', { reading: 'アメ', pitches: [{ position: 'LHH' }, { position: 0, nasal: 2, devoice: [1] }] }])).toEqual({
      expression: '飴',
      mode: 'pitch',
      data: { reading: 'あめ', pitches: [{ position: 0 }, { position: 0, nasal: [2], devoice: [1] }] },
    });
    expect(parseYomitanMetaRow(['x', 'pitch', { reading: 'x', pitches: [] }])).toBeNull();
    expect(parseYomitanMetaRow(['x', 'pitch', { pitches: [{ position: 1 }] }])).toBeNull();
    expect(pitchPatternToPosition('HLL')).toBe(1);
    expect(pitchPatternToPosition('LHL')).toBe(2);
    expect(pitchPatternToPosition('LHH')).toBe(0);
    expect(pitchPatternToPosition('xyz')).toBeUndefined();
  });

  it('parses all frequency shapes and flags ㋕ kana-only frequencies', () => {
    expect(parseYomitanMetaRow(['賭ける', 'freq', { reading: 'かける', frequency: { value: 3851, displayValue: '3851' } }])).toEqual({ expression: '賭ける', mode: 'freq', data: { reading: 'かける', value: 3851, displayValue: '3851' } });
    expect(parseYomitanMetaRow(['かける', 'freq', { value: 202, displayValue: '202㋕' }])).toEqual({ expression: 'かける', mode: 'freq', data: { value: 202, displayValue: '202㋕', kanaOnly: true } });
    expect(parseYomitanMetaRow(['掛ける', 'freq', { reading: 'かける', frequency: { value: 202, displayValue: '202㋕' } }])?.data).toEqual({ reading: 'かける', value: 202, displayValue: '202㋕', kanaOnly: true });
    expect(parseYomitanMetaRow(['猫', 'freq', 812])?.data).toEqual({ value: 812, displayValue: '812' });
    expect(parseYomitanMetaRow(['猫', 'freq', { reading: 'ねこ', frequency: 99 }])?.data).toEqual({ reading: 'ねこ', value: 99, displayValue: '99' });
    expect(parseYomitanMetaRow(['猫', 'freq', { reading: 'ねこ', value: 5 }])?.data).toEqual({ reading: 'ねこ', value: 5, displayValue: '5' });
    expect(parseYomitanMetaRow(['猫', 'freq', 'abc'])).toBeNull();
    expect(parseYomitanMetaRow(['猫', 'ipa', {}])).toBeNull();
  });

  it('accumulates meta rows per (expression, mode)', () => {
    const acc = new MetaRowAccumulator('jpdb');
    for (const row of [
      ['掛ける', 'freq', { reading: 'かける', frequency: { value: 2055, displayValue: '2055' } }],
      ['掛ける', 'freq', { reading: 'かける', frequency: { value: 202, displayValue: '202㋕' } }],
      ['かける', 'freq', { value: 202, displayValue: '202㋕' }],
    ]) {
      const p = parseYomitanMetaRow(row);
      if (p) acc.add(p);
    }
    expect(acc.size).toBe(2);
    const out = acc.drain();
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.expression === '掛ける')?.entries).toHaveLength(2);
    expect(acc.size).toBe(0);
  });
});
