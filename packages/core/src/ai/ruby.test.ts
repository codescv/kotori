import { describe, expect, it } from 'vitest';
import { buildRuby, hasKanji, plainRuns, sliceRuby } from './ruby';

const join = (segs: { base: string }[]): string => segs.map((s) => s.base).join('');

describe('buildRuby', () => {
  it('uses the model segmentation when it reproduces the sentence', () => {
    const s = '今日は学校に行きたくない。';
    const r = buildRuby(s, [
      { base: '今日', ruby: 'キョウ' },
      { base: 'は', ruby: 'は' },
      { base: '学校', ruby: 'がっこう' },
      { base: 'に' },
      { base: '行', ruby: 'い' },
      { base: 'きたくない。' },
    ]);
    expect(join(r)).toBe(s);
    expect(r[0]).toEqual({ base: '今日', ruby: 'きょう', charSpan: [0, 2] });
    expect(r[1]).toEqual({ base: 'は', charSpan: [2, 3] }); // no ruby on kana
    expect(r[4]).toEqual({ base: '行', ruby: 'い', charSpan: [6, 7] });
  });

  it('falls back to aligned readings + plain runs on mismatch', () => {
    const s = '俺の名前は太郎だ！';
    const r = buildRuby(s, [{ base: '名前', ruby: 'なまえ' }, { base: 'わ' }, { base: '太郎', ruby: 'たろう' }]);
    expect(join(r)).toBe(s);
    expect(r.find((x) => x.base === '名前')?.ruby).toBe('なまえ');
    expect(r.find((x) => x.base === '太郎')?.ruby).toBe('たろう');
    expect(r.find((x) => x.base === '俺')).toEqual({ base: '俺', charSpan: [0, 1] });
    // charSpans are contiguous
    let pos = 0;
    for (const seg of r) {
      expect(seg.charSpan).toEqual([pos, pos + seg.base.length]);
      pos += seg.base.length;
    }
  });

  it('always reproduces the sentence for garbage input', () => {
    const s = 'ﾃｽﾄ漢字かな𠮷野家';
    for (const raw of [[], [{ base: 'xyz', ruby: 'a' }], [{ base: '漢字', ruby: 'かんじ' }, { base: '漢字', ruby: 'x' }], [{ base: '' }]]) {
      expect(join(buildRuby(s, raw))).toBe(s);
    }
    expect(buildRuby('', [{ base: 'a' }])).toEqual([]);
  });
});

describe('helpers', () => {
  it('hasKanji / plainRuns', () => {
    expect(hasKanji('かな')).toBe(false);
    expect(hasKanji('仮名')).toBe(true);
    expect(plainRuns('食べ物です', 3).map((s) => [s.base, s.charSpan])).toEqual([
      ['食', [3, 4]],
      ['べ', [4, 5]],
      ['物', [5, 6]],
      ['です', [6, 8]],
    ]);
  });

  it('sliceRuby splits straddling segments and drops their reading', () => {
    const r = buildRuby('学校に行く', [{ base: '学校', ruby: 'がっこう' }, { base: 'に' }, { base: '行', ruby: 'い' }, { base: 'く' }]);
    expect(sliceRuby(r, [0, 3])).toEqual([
      { base: '学校', ruby: 'がっこう', charSpan: [0, 2] },
      { base: 'に', charSpan: [2, 3] },
    ]);
    expect(sliceRuby(r, [1, 2])).toEqual([{ base: '校', charSpan: [1, 2] }]);
  });
});
