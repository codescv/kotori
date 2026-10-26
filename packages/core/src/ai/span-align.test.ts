import { describe, expect, it } from 'vitest';
import { alignSpans, clampSpans, spansCover } from './span-align';

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [...'あいうえおかきくけこのはをにでがてんじゃねぇよ食学校行今日私猫犬ー、。！？ 　ABCabc123ｶﾀ𠮷'];

describe('alignSpans', () => {
  it('aligns exact surfaces monotonically', () => {
    const r = alignSpans('食べてんじゃねぇよ', ['食べ', 'てんじゃねぇ', 'よ']);
    expect(r.spans).toEqual([
      [0, 2],
      [2, 8],
      [8, 9],
    ]);
    expect(r.alignment).toEqual(['exact', 'exact', 'exact']);
  });

  it('never matches before the previous end (repeated surfaces)', () => {
    const r = alignSpans('ははは', ['は', 'は', 'は', 'は']);
    expect(r.spans).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 3],
    ]);
    expect(r.alignment).toEqual(['exact', 'exact', 'exact', 'unaligned']);
  });

  it('falls back to fuzzy matching (width, katakana, spaces, wave dash, long vowel)', () => {
    const s = 'ﾃｽﾄ です　よ～ すげー';
    const r = alignSpans(s, ['テスト', 'ですよ〜', 'すげｰ']);
    expect(r.alignment).toEqual(['fuzzy', 'fuzzy', 'fuzzy']);
    expect(s.slice(...(r.spans[0] as [number, number]))).toBe('ﾃｽﾄ');
    expect(s.slice(...(r.spans[1] as [number, number]))).toBe('です　よ～');
    expect(s.slice(...(r.spans[2] as [number, number]))).toBe('すげー');
  });

  it('marks missing surfaces unaligned at the cursor', () => {
    const r = alignSpans('今日は雨', ['今日', '晴れ', 'は', '']);
    expect(r.spans).toEqual([
      [0, 2],
      [2, 2],
      [2, 3],
      [3, 3],
    ]);
    expect(r.alignment).toEqual(['exact', 'unaligned', 'exact', 'unaligned']);
  });

  it('property: random substring splits are all exact, disjoint and ordered', () => {
    const rand = rng(1234);
    for (let iter = 0; iter < 500; iter++) {
      const len = 1 + Math.floor(rand() * 30);
      let sentence = '';
      for (let i = 0; i < len; i++) sentence += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      // Random cut points on code-point boundaries.
      const cps = [...sentence];
      const cuts = new Set<number>();
      for (let i = 1; i < cps.length; i++) if (rand() < 0.35) cuts.add(i);
      const pieces: string[] = [];
      let last = 0;
      for (const c of [...cuts].sort((a, b) => a - b)) {
        pieces.push(cps.slice(last, c).join(''));
        last = c;
      }
      pieces.push(cps.slice(last).join(''));
      // Optionally drop some pieces (gaps are allowed, order must hold).
      const surfaces = pieces.filter(() => rand() > 0.2);
      const r = alignSpans(sentence, surfaces);
      let prevEnd = 0;
      r.spans.forEach(([s, e], k) => {
        expect(r.alignment[k]).toBe('exact');
        expect(s).toBeGreaterThanOrEqual(prevEnd);
        expect(e).toBeGreaterThanOrEqual(s);
        expect(sentence.slice(s, e)).toBe(surfaces[k]);
        prevEnd = e;
      });
    }
  });
});

describe('clampSpans', () => {
  it('clamps, fixes inversion and enforces monotonic order', () => {
    expect(
      clampSpans(
        [
          [-3, 2],
          [1, 4],
          [6, 5],
          [8, 100],
        ],
        10,
      ),
    ).toEqual([
      [0, 2],
      [2, 4],
      [6, 6],
      [8, 10],
    ]);
  });
});

describe('spansCover', () => {
  it('measures coverage of non-punctuation characters', () => {
    expect(spansCover('今日は、雨。', [[0, 3]])).toBeCloseTo(3 / 4);
    expect(
      spansCover('今日は、雨。', [
        [0, 3],
        [4, 5],
      ]),
    ).toBe(1);
    expect(spansCover('。。', [])).toBe(1);
    expect(spansCover('𠮷', [[0, 1]])).toBe(0.5);
  });
});
