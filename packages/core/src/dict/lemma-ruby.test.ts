import { describe, expect, it } from 'vitest';
import type { RubySegment } from '../types';
import { JUKUJIKUN_READINGS, computeLemmaRuby } from './lemma-ruby';

const pairs = (segs: readonly RubySegment[]): Array<[string, string | undefined]> => segs.map((s) => [s.base, s.ruby]);
const join = (segs: readonly RubySegment[]): string => segs.map((s) => s.base).join('');

describe('computeLemmaRuby', () => {
  it('pure kana and empty input carry no ruby', () => {
    expect(computeLemmaRuby('やっぱり', 'やっぱり')).toEqual([{ base: 'やっぱり', charSpan: [0, 4] }]);
    expect(computeLemmaRuby('ムカつく', 'むかつく')).toEqual([{ base: 'ムカつく', charSpan: [0, 4] }]);
    expect(computeLemmaRuby('', 'x')).toEqual([]);
  });

  it('strips okurigana suffix / prefix', () => {
    expect(computeLemmaRuby('食べる', 'たべる')).toEqual([
      { base: '食', ruby: 'た', charSpan: [0, 1] },
      { base: 'べる', charSpan: [1, 3] },
    ]);
    expect(pairs(computeLemmaRuby('賭ける', 'カケル'))).toEqual([['賭', 'か'], ['ける', undefined]]);
    expect(pairs(computeLemmaRuby('高い', 'たかい'))).toEqual([['高', 'たか'], ['い', undefined]]);
    expect(pairs(computeLemmaRuby('お茶', 'おちゃ'))).toEqual([['お', undefined], ['茶', 'ちゃ']]);
    expect(pairs(computeLemmaRuby('分かる', 'わかる'))).toEqual([['分', 'わ'], ['かる', undefined]]);
  });

  it('aligns compounds with inner kana', () => {
    expect(computeLemmaRuby('取り戻す', 'とりもどす')).toEqual([
      { base: '取', ruby: 'と', charSpan: [0, 1] },
      { base: 'り', charSpan: [1, 2] },
      { base: '戻', ruby: 'もど', charSpan: [2, 3] },
      { base: 'す', charSpan: [3, 4] },
    ]);
    expect(pairs(computeLemmaRuby('引っ越す', 'ひっこす'))).toEqual([['引', 'ひ'], ['っ', undefined], ['越', 'こ'], ['す', undefined]]);
    expect(pairs(computeLemmaRuby('申し込む', 'もうしこむ'))).toEqual([['申', 'もう'], ['し', undefined], ['込', 'こ'], ['む', undefined]]);
    expect(pairs(computeLemmaRuby('思い出す', 'おもいだす'))).toEqual([['思', 'おも'], ['い', undefined], ['出', 'だ'], ['す', undefined]]);
    expect(pairs(computeLemmaRuby('言い訳', 'いいわけ'))).toEqual([['言', 'い'], ['い', undefined], ['訳', 'わけ']]);
  });

  it('keeps multi-kanji runs and jukujikun as one group', () => {
    expect(pairs(computeLemmaRuby('勉強', 'べんきょう'))).toEqual([['勉強', 'べんきょう']]);
    expect(pairs(computeLemmaRuby('明日', 'あした'))).toEqual([['明日', 'あした']]);
    expect(pairs(computeLemmaRuby('大人しい', 'おとなしい'))).toEqual([['大人', 'おとな'], ['しい', undefined]]);
    expect(pairs(computeLemmaRuby('真面目', 'まじめ'))).toEqual([['真面目', 'まじめ']]);
  });

  it('uses JUKUJIKUN_READINGS when the reading is missing', () => {
    expect(JUKUJIKUN_READINGS['今日']).toBe('きょう');
    expect(pairs(computeLemmaRuby('今日', ''))).toEqual([['今日', 'きょう']]);
    expect(pairs(computeLemmaRuby('一人', ''))).toEqual([['一人', 'ひとり']]);
    expect(pairs(computeLemmaRuby('猫', ''))).toEqual([['猫', undefined]]);
  });

  it('falls back to prefix / suffix stripping when kana do not align', () => {
    // Reading disagrees with the inner kana (irregular): group everything between matching edges.
    const segs = computeLemmaRuby('お巡りさん', 'おまわりさん');
    expect(join(segs)).toBe('お巡りさん');
    expect(pairs(segs)).toEqual([['お', undefined], ['巡', 'まわ'], ['りさん', undefined]]);
    const odd = computeLemmaRuby('日本語ヲ', 'にほんご');
    expect(join(odd)).toBe('日本語ヲ');
    expect(odd.some((s) => s.ruby !== undefined)).toBe(true);
  });

  it('always reproduces the lemma and spans', () => {
    for (const [l, r] of [['見つける', 'みつける'], ['落ち着く', 'おちつく'], ['当たり前', 'あたりまえ'], ['々', 'x'], ['ヶ月', 'かげつ']] as const) {
      const segs = computeLemmaRuby(l, r);
      expect(join(segs)).toBe(l);
      let pos = 0;
      for (const s of segs) {
        expect(s.charSpan).toEqual([pos, pos + s.base.length]);
        pos += s.base.length;
      }
    }
  });
});
