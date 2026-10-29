import { describe, expect, it } from 'vitest';
import type { SentenceExplanation, TargetLanguage } from '../types';
import { explanationCacheKey, explanationCacheKeySync } from './cache-key';
import { EXPLAIN_RESPONSE_SCHEMA, RawExplanationSchema, parseModelJson, RawPageGuideSchema, RawBubbleOcrSchema } from './explain-schema';
import { chunkIndexAt, findChunkAt, findVocabAt, isGapCharAt, toSentenceExplanation } from './explanation';
import { aiFixture } from './test-helpers';

interface Fixture {
  sentence: string;
  targetLanguage: TargetLanguage;
  raw: unknown;
}

const standard = aiFixture<Fixture>('gemini-standard.json');
const slang = aiFixture<Fixture>('gemini-slang.json');

function build(f: Fixture): SentenceExplanation {
  const raw = RawExplanationSchema.parse(f.raw);
  return toSentenceExplanation(raw, { sentence: f.sentence, targetLanguage: f.targetLanguage }, { model: 'gemini-2.5-flash', now: 1000, usage: { promptTokens: 1, outputTokens: 2 } });
}

describe('RawExplanationSchema', () => {
  it('accepts both fixtures', () => {
    expect(RawExplanationSchema.safeParse(standard.raw).success).toBe(true);
    expect(RawExplanationSchema.safeParse(slang.raw).success).toBe(true);
  });

  it('is tolerant of nulls, unknown enums and missing arrays', () => {
    const r = RawExplanationSchema.parse({
      translation: 'x',
      literalTranslation: null,
      register: 'Very Rough',
      chunks: [{ surface: 'a', reading: 'a', textbookForm: null, role: 'r', meaning: 'm', vocab: [{ surface: 'a', lemma: 'a', lemmaReading: 'a', partOfSpeech: 'Proper Noun', meaning: 'm', jlpt: 'n3', pitchAccent: '2' }] }],
    });
    expect(r.literalTranslation).toBeUndefined();
    expect(r.register).toBeUndefined();
    expect(r.ruby).toEqual([]);
    expect(r.grammar).toEqual([]);
    expect(r.chunks[0]?.textbookForm).toBe('');
    expect(r.chunks[0]?.vocab[0]?.partOfSpeech).toBe('proper-noun');
    expect(r.chunks[0]?.vocab[0]?.jlpt).toBe('N3');
    expect(r.chunks[0]?.vocab[0]?.pitchAccent).toBe(2);
    expect(r.chunks[0]?.vocab[0]?.lemmaRuby).toBeUndefined();
    expect(RawExplanationSchema.parse({ ...(r as object), chunks: [{ ...r.chunks[0], vocab: [{ ...r.chunks[0]?.vocab[0], partOfSpeech: 'gerund' }] }] }).chunks[0]?.vocab[0]?.partOfSpeech).toBe('other');
  });

  it('P1 schema slimming: vocab no longer requests lemmaRuby / jlpt but keeps notes', () => {
    const vocab = EXPLAIN_RESPONSE_SCHEMA.properties.chunks.items.properties.vocab.items;
    expect(Object.keys(vocab.properties)).not.toContain('lemmaRuby');
    expect(Object.keys(vocab.properties)).not.toContain('jlpt');
    expect(Object.keys(vocab.properties)).toContain('notes');
    expect(vocab.required).toEqual(['surface', 'lemma', 'lemmaReading', 'partOfSpeech', 'meaning']);
    expect(vocab.propertyOrdering).not.toContain('lemmaRuby');
  });

  it('computes lemmaRuby locally when the model omits it, and keeps legacy model ruby', () => {
    const raw = RawExplanationSchema.parse({
      translation: 't',
      ruby: [{ base: '命', ruby: 'いのち' }, { base: 'をかけて' }],
      chunks: [
        {
          surface: '命をかけて',
          reading: 'いのちをかけて',
          textbookForm: '命を賭けて',
          role: 'r',
          meaning: 'm',
          vocab: [
            { surface: '命', lemma: '命', lemmaReading: 'いのち', partOfSpeech: 'noun', meaning: '生命' },
            { surface: 'かけて', lemma: '賭ける', lemmaReading: 'かける', partOfSpeech: 'verb', meaning: '赌上', notes: '孤注一掷' },
          ],
        },
      ],
    });
    const e = toSentenceExplanation(raw, { sentence: '命をかけて', targetLanguage: 'zh-CN' }, { model: 'm', now: 1 });
    expect(e.vocab[0]?.lemmaRuby).toEqual([{ base: '命', ruby: 'いのち', charSpan: [0, 1] }]);
    expect(e.vocab[1]?.lemmaRuby).toEqual([
      { base: '賭', ruby: 'か', charSpan: [0, 1] },
      { base: 'ける', charSpan: [1, 3] },
    ]);
    expect(e.vocab[1]?.notes).toBe('孤注一掷');
    expect(e.vocab[1]?.jlpt).toBeUndefined();
    // Legacy cached / v2 response with model ruby still honoured.
    const legacy = build(slang);
    expect(legacy.vocab.find((v) => v.lemma === '食べる')?.lemmaRuby[0]).toMatchObject({ base: '食', ruby: 'た' });
  });

  it('rejects output without a translation', () => {
    expect(RawExplanationSchema.safeParse({ chunks: [] }).success).toBe(false);
  });

  it('Gemini schema lists required top-level keys and folds grammarPattern into chunks', () => {
    expect(EXPLAIN_RESPONSE_SCHEMA.required).toEqual(['translation', 'ruby', 'chunks']);
    expect('grammar' in EXPLAIN_RESPONSE_SCHEMA.properties).toBe(false);
    expect(EXPLAIN_RESPONSE_SCHEMA.propertyOrdering).not.toContain('grammar');
    const chunkSchema = EXPLAIN_RESPONSE_SCHEMA.properties.chunks.items;
    expect(chunkSchema.properties.textbookForm.type).toBe('STRING');
    expect(chunkSchema.properties.grammarPattern).toEqual({ type: 'STRING' });
    expect(chunkSchema.required).not.toContain('grammarPattern');
    expect(chunkSchema.propertyOrdering.indexOf('grammarPattern')).toBe(
      chunkSchema.propertyOrdering.indexOf('spokenEvolution') + 1,
    );
  });

  it('vision schemas coerce sloppy values', () => {
    expect(RawBubbleOcrSchema.parse({ lines: ['a'], vertical: null }).vertical).toBe(true);
    const g = RawPageGuideSchema.parse({ summary: 's', bubbles: [{ order: '2', box: { left: '1', top: 2, right: 3, bottom: 'x' }, text: 't', translation: 'tr' }] });
    expect(g.bubbles[0]?.order).toBe(2);
    expect(g.bubbles[0]?.box).toEqual({ left: 1, top: 2, right: 3, bottom: 0 });
  });
});

describe('parseModelJson', () => {
  it('strips code fences', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson(' {"a":2} ')).toEqual({ a: 2 });
    expect(() => parseModelJson('nope')).toThrow();
  });
});

describe('toSentenceExplanation', () => {
  it('builds the standard sentence with aligned chunks, vocab and grammar', () => {
    const e = build(standard);
    expect(e.sentence).toBe(standard.sentence);
    expect(e.ruby.map((r) => r.base).join('')).toBe(e.sentence);
    expect(e.chunks.map((c) => [c.id, c.surface, c.charSpan, c.alignment])).toEqual([
      ['c0', '今日は', [0, 3], 'exact'],
      ['c1', '学校に', [3, 6], 'exact'],
      ['c2', '行きたくない', [6, 12], 'exact'],
    ]);
    expect(e.chunks[0]?.vocabIds).toEqual(['v0', 'v1']);
    expect(e.vocab.map((v) => [v.id, v.surface, v.charSpan])).toEqual([
      ['v0', '今日', [0, 2]],
      ['v1', 'は', [2, 3]],
      ['v2', '学校', [3, 5]],
      ['v3', 'に', [5, 6]],
      ['v4', '行き', [6, 8]],
      ['v5', 'たくない', [8, 12]],
    ]);
    expect(e.vocab[4]?.lemmaRuby).toEqual([
      { base: '行', ruby: 'い', charSpan: [0, 1] },
      { base: 'く', charSpan: [1, 2] },
    ]);
    expect(e.chunks[0]?.ruby).toEqual([
      { base: '今日', ruby: 'きょう', charSpan: [0, 2] },
      { base: 'は', charSpan: [2, 3] },
    ]);
    expect(e.chunks[2]?.spokenEvolution).toBeUndefined();
    expect(e.grammar[0]).toMatchObject({ id: 'g0', pattern: '〜たい', chunkIds: ['c2'], jlpt: 'N5' });
    expect(e.id).toMatch(/^ex_[0-9a-f]{16}$/);
    expect(e).toMatchObject({ targetLanguage: 'zh-CN', model: 'gemini-2.5-flash', promptVersion: 'v3', createdAt: 1000, fromCache: false, register: 'plain' });
    expect(e.usage).toEqual({ promptTokens: 1, outputTokens: 2 });
    expect('literalTranslation' in e).toBe(false);
  });

  it('keeps spoken evolution for the slangy chunk てんじゃねぇ', () => {
    const e = build(slang);
    const c = e.chunks[1];
    expect(c?.surface).toBe('てんじゃねぇ');
    expect(c?.charSpan).toEqual([2, 8]);
    expect(c?.textbookForm).toBe('ているのではない');
    expect(c?.spokenEvolution?.kind).toBe('縮約');
    expect(c?.spokenEvolution?.formality).toBeCloseTo(0.05);
    expect(c?.vocabIds).toEqual(['v1', 'v2']);
    expect(e.vocab[2]?.charSpan).toEqual([4, 8]);
    expect(e.grammar.map((g) => g.chunkIds)).toEqual([['c1'], ['c2']]);
    expect(e.register).toBe('rough');
    expect(e.literalTranslation).toBeDefined();
  });

  it('drops spoken evolution when surface equals textbook form and handles unaligned chunks', () => {
    const raw = RawExplanationSchema.parse({
      translation: 't',
      ruby: [],
      chunks: [
        { surface: 'ねこ', reading: 'ねこ', textbookForm: 'ネコ', spokenEvolution: { kind: 'x', derivation: 'y' }, role: '', meaning: '', vocab: [{ surface: 'ねこ', lemma: '', lemmaReading: 'ねこ', lemmaRuby: [], partOfSpeech: 'noun', meaning: 'cat' }] },
        { surface: 'いぬ', reading: 'いぬ', textbookForm: '', role: '', meaning: '', vocab: [{ surface: 'いぬ', lemma: 'いぬ', lemmaReading: 'いぬ', lemmaRuby: [], partOfSpeech: 'noun', meaning: 'dog' }] },
      ],
      grammar: [{ pattern: 'p', chunkSurfaces: ['ネコ', 'zzz'], explanation: 'e' }],
    });
    const e = toSentenceExplanation(raw, { sentence: 'ねこだ', targetLanguage: 'en' }, { model: 'm', now: 0, id: 'ex_fixed' });
    expect(e.id).toBe('ex_fixed');
    expect(e.chunks[0]?.spokenEvolution).toBeUndefined();
    expect(e.chunks[1]).toMatchObject({ alignment: 'unaligned', charSpan: [2, 2], surface: 'いぬ', textbookForm: 'いぬ' });
    expect(e.vocab[0]?.lemma).toBe('ねこ');
    expect(e.vocab[1]).toMatchObject({ alignment: 'unaligned', surface: 'いぬ' });
    expect(e.grammar[0]?.chunkIds).toEqual(['c0']);
    expect(e.ruby.map((r) => r.base).join('')).toBe('ねこだ');
  });

  it('normalizes new responses without grammar (with chunk.grammarPattern) and legacy responses with grammar[]', () => {
    const rawNew = RawExplanationSchema.parse({
      translation: '不小心吃光了',
      ruby: [{ base: '食', ruby: 'た' }, { base: 'べちゃった' }],
      chunks: [
        {
          surface: '食べ',
          reading: 'たべ',
          textbookForm: '食べ',
          grammarPattern: '   ',
          role: '谓语动词',
          meaning: '吃',
          vocab: [{ surface: '食べ', lemma: '食べる', lemmaReading: 'たべる', partOfSpeech: 'verb', meaning: '吃' }],
        },
        {
          surface: 'ちゃった',
          reading: 'ちゃった',
          textbookForm: 'てしまった',
          spokenEvolution: { kind: '縮約', derivation: 'てしまった → ちゃった' },
          grammarPattern: '  〜てしまう  ',
          role: '补助动词',
          meaning: '表示动作彻底完成并带有一丝懊悔',
          nuance: '口语缩约，语气随性',
          vocab: [{ surface: 'ちゃった', lemma: 'しまう', lemmaReading: 'しまう', partOfSpeech: 'auxiliary', meaning: '完了/不小心' }],
        },
      ],
    });
    const normNew = toSentenceExplanation(rawNew, { sentence: '食べちゃった', targetLanguage: 'zh-CN' }, { model: 'gemini-2.5-flash', now: 100 });
    expect(normNew.grammar).toEqual([]);
    expect('grammarPattern' in normNew.chunks[0]!).toBe(false);
    expect(normNew.chunks[1]?.grammarPattern).toBe('〜てしまう');

    const rawLegacy = RawExplanationSchema.parse({
      translation: '不想去',
      ruby: [{ base: '行', ruby: 'い' }, { base: 'きたくない' }],
      chunks: [
        {
          surface: '行きたくない',
          reading: 'いきたくない',
          textbookForm: '行きたくない',
          role: '谓语',
          meaning: '不想去',
          vocab: [{ surface: '行き', lemma: '行く', lemmaReading: 'いく', partOfSpeech: 'verb', meaning: '去' }],
        },
      ],
      grammar: [{ pattern: '〜たい', chunkSurfaces: ['行きたくない'], explanation: '表示愿望', jlpt: 'N5' }],
    });
    const normLegacy = toSentenceExplanation(rawLegacy, { sentence: '行きたくない', targetLanguage: 'zh-CN' }, { model: 'gemini-2.5-flash', now: 200 });
    expect(normLegacy.grammar).toEqual([
      { id: 'g0', pattern: '〜たい', chunkIds: ['c0'], explanation: '表示愿望', jlpt: 'N5' },
    ]);
  });
});

describe('findChunkAt / chunkIndexAt / findVocabAt', () => {
  const e = build(standard); // 今日は|学校に|行きたくない|。
  it('finds the containing chunk', () => {
    expect(findChunkAt(e, 0)?.id).toBe('c0');
    expect(findChunkAt(e, 2)?.id).toBe('c0');
    expect(findChunkAt(e, 3)?.id).toBe('c1');
    expect(findChunkAt(e, 11)?.id).toBe('c2');
    expect(chunkIndexAt(e, 7)).toBe(2);
  });
  it('treats clicks between chunks as nearest right, else left', () => {
    // '。' at 12 is uncovered and last → nearest left.
    expect(findChunkAt(e, 12)?.id).toBe('c2');
    const gapped = { chunks: [{ ...e.chunks[0]!, charSpan: [0, 2] as const }, { ...e.chunks[1]!, charSpan: [4, 6] as const }] };
    expect(findChunkAt(gapped, 3)?.id).toBe('c1');
    expect(findChunkAt(gapped, 99)?.id).toBe('c1');
    expect(findChunkAt({ chunks: [] }, 0)).toBeUndefined();
    expect(chunkIndexAt({ chunks: [] }, 0)).toBe(-1);
  });
  it('finds vocab only when contained', () => {
    expect(findVocabAt(e, 1)?.surface).toBe('今日');
    expect(findVocabAt(e, 9)?.surface).toBe('たくない');
    expect(findVocabAt(e, 12)).toBeUndefined();
  });
  it('isGapCharAt detects punctuation', () => {
    expect(isGapCharAt(e.sentence, 12)).toBe(true);
    expect(isGapCharAt(e.sentence, 0)).toBe(false);
    expect(isGapCharAt(e.sentence, 99)).toBe(true);
  });
});

describe('explanationCacheKey', () => {
  const input = { sentence: '食べてんじゃねぇよ', targetLanguage: 'zh-CN' as const, model: 'gemini-2.5-flash', promptVersion: 'v1' };
  it('is a stable sha256 with ex_ prefix', async () => {
    const a = await explanationCacheKey(input);
    expect(a).toMatch(/^ex_[0-9a-f]{64}$/);
    expect(await explanationCacheKey({ ...input })).toBe(a);
    expect(await explanationCacheKey({ ...input, model: 'other' })).not.toBe(a);
    expect(await explanationCacheKey({ ...input, promptVersion: 'v2' })).not.toBe(a);
    expect(await explanationCacheKey({ ...input, targetLanguage: 'en' })).not.toBe(a);
  });
  it('has a sync fnv fallback', () => {
    expect(explanationCacheKeySync(input)).toMatch(/^ex_[0-9a-f]{16}$/);
    expect(explanationCacheKeySync(input)).toBe(explanationCacheKeySync({ ...input }));
  });
});
