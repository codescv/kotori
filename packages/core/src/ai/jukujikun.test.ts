import { describe, expect, it } from 'vitest';
import type { RubySegment } from '../types';
import { toSentenceExplanation } from './explanation';
import { RawExplanationSchema } from './explain-schema';
import { buildRuby, normalizeJukujikunRuby } from './ruby';

const join = (segs: readonly RubySegment[]): string => segs.map((s) => s.base).join('');

describe('normalizeJukujikunRuby', () => {
  it('merges 明(あ)日(ひ) into 明日(あした) using the chunk reading', () => {
    const s = '明日の天気';
    const ruby = buildRuby(s, [{ base: '明', ruby: 'あ' }, { base: '日', ruby: 'ひ' }, { base: 'の' }, { base: '天気', ruby: 'てんき' }]);
    const out = normalizeJukujikunRuby(ruby, [
      { charSpan: [0, 3], reading: 'あしたの' },
      { charSpan: [3, 5], reading: 'てんき' },
    ]);
    expect(join(out)).toBe(s);
    expect(out).toEqual([
      { base: '明日', ruby: 'あした', charSpan: [0, 2] },
      { base: 'の', charSpan: [2, 3] },
      { base: '天気', ruby: 'てんき', charSpan: [3, 5] },
    ]);
  });

  it('handles kana prefixes, katakana readings and leaves consistent splits alone', () => {
    const s = 'お二人さん';
    const ruby = buildRuby(s, [{ base: 'お' }, { base: '二', ruby: 'に' }, { base: '人', ruby: 'にん' }, { base: 'さん' }]);
    const out = normalizeJukujikunRuby(ruby, [{ charSpan: [0, 5], reading: 'オフタリサン' }]);
    expect(join(out)).toBe(s);
    expect(out).toEqual([
      { base: 'お', charSpan: [0, 1] },
      { base: '二人', ruby: 'ふたり', charSpan: [1, 3] },
      { base: 'さん', charSpan: [3, 5] },
    ]);

    const ok = buildRuby('日本語', [{ base: '日本', ruby: 'にほん' }, { base: '語', ruby: 'ご' }]);
    expect(normalizeJukujikunRuby(ok, [{ charSpan: [0, 3], reading: 'にほんご' }])).toEqual(ok);
  });

  it('skips unaligned chunks, kanji split by kana and irreconcilable readings', () => {
    const s = '見て行く';
    const ruby = buildRuby(s, [{ base: '見', ruby: 'み' }, { base: 'て' }, { base: '行', ruby: 'い' }, { base: 'く' }]);
    expect(normalizeJukujikunRuby(ruby, [{ charSpan: [0, 4], reading: 'みにいく' }])).toEqual(ruby);
    const tomorrow = buildRuby('明日', [{ base: '明', ruby: 'あ' }, { base: '日', ruby: 'ひ' }]);
    expect(normalizeJukujikunRuby(tomorrow, [{ charSpan: [0, 0], reading: 'あした', alignment: 'unaligned' }])).toEqual(tomorrow);
    const withNo = buildRuby('明日の', [{ base: '明', ruby: 'あ' }, { base: '日', ruby: 'ひ' }, { base: 'の' }]);
    expect(normalizeJukujikunRuby(withNo, [{ charSpan: [0, 3], reading: 'あしたが' }])).toEqual(withNo);
  });

  it('is applied by toSentenceExplanation to sentence and chunk ruby', () => {
    const raw = RawExplanationSchema.parse({
      translation: '明天见',
      ruby: [{ base: '明', ruby: 'あ' }, { base: '日', ruby: 'ひ' }, { base: 'また' }],
      chunks: [
        { surface: '明日', reading: 'あした', textbookForm: '明日', role: '时间', meaning: '明天', vocab: [{ surface: '明日', lemma: '明日', lemmaReading: 'あした', lemmaRuby: [{ base: '明', ruby: 'みょう' }, { base: '日', ruby: 'にち' }], partOfSpeech: 'noun', meaning: '明天' }] },
        { surface: 'また', reading: 'また', textbookForm: 'また', role: '副词', meaning: '再', vocab: [] },
      ],
      grammar: [],
    });
    const e = toSentenceExplanation(raw, { sentence: '明日また', targetLanguage: 'zh-CN' }, { model: 'm', now: 1 });
    expect(e.ruby[0]).toEqual({ base: '明日', ruby: 'あした', charSpan: [0, 2] });
    expect(e.chunks[0]?.ruby).toEqual([{ base: '明日', ruby: 'あした', charSpan: [0, 2] }]);
    expect(e.vocab[0]?.lemmaRuby).toEqual([{ base: '明日', ruby: 'あした', charSpan: [0, 2] }]);
  });
});
