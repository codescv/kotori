import { describe, expect, it } from 'vitest';
import { bytesToHex, fnv1a64, hasSubtleCrypto, sha256Hex } from './hash';
import { graphemeCount, segmentGraphemes, splitGraphemes } from './graphemes';
import { isHiragana, isKana, isKanji, isKatakana, katakanaToHiragana, normaliseJapanese, normaliseJapaneseWithMap, isPunctuationOrSpace } from './text';
import { formatClock, parseClock } from './time';
import { compareNatural } from './natural-sort';

describe('hash', () => {
  it('sha256Hex matches known vectors', async () => {
    expect(hasSubtleCrypto()).toBe(true);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(await sha256Hex('abc'));
  });
  it('fnv1a64 matches known vectors and is 16 hex chars', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
    expect(fnv1a64('日本語')).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64('日本語')).not.toBe(fnv1a64('日本'));
  });
  it('bytesToHex pads', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

describe('graphemes', () => {
  it('splits combining sequences and emoji as single graphemes', () => {
    expect(splitGraphemes('か゚👨‍👩‍👧a')).toEqual(['か゚', '👨‍👩‍👧', 'a']);
    expect(graphemeCount('か゚👨‍👩‍👧a')).toBe(3);
    expect(graphemeCount('手')).toBe(1);
    expect(graphemeCount('')).toBe(0);
  });
  it('reports UTF-16 offsets', () => {
    const segs = segmentGraphemes('𠮷野家');
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 3],
      [3, 4],
    ]);
  });
});

describe('text', () => {
  it('classifies characters', () => {
    expect(isKanji('漢')).toBe(true);
    expect(isKanji('々')).toBe(true);
    expect(isKanji('𠮷')).toBe(true);
    expect(isKanji('か')).toBe(false);
    expect(isKana('か')).toBe(true);
    expect(isKana('カ')).toBe(true);
    expect(isKana('ｶ')).toBe(true);
    expect(isKana('ー')).toBe(true);
    expect(isKana('a')).toBe(false);
    expect(isHiragana('ア')).toBe(false);
    expect(isKatakana('ア')).toBe(true);
    expect(isPunctuationOrSpace('、')).toBe(true);
    expect(isPunctuationOrSpace('　')).toBe(true);
    expect(isPunctuationOrSpace('あ')).toBe(false);
  });
  it('converts katakana to hiragana', () => {
    expect(katakanaToHiragana('カタカナとヴァイオリン')).toBe('かたかなとゔぁいおりん');
    expect(katakanaToHiragana('ー漢')).toBe('ー漢');
  });
  it('normalises for fuzzy comparison', () => {
    expect(normaliseJapanese('ﾃｽﾄ　です ～')).toBe('てすとです〜');
    expect(normaliseJapanese('すげー')).toBe(normaliseJapanese('すげｰ'));
    expect(normaliseJapanese('ＡＢＣ')).toBe('abc');
  });
  it('maps normalised offsets back to source', () => {
    const { text, map, endMap } = normaliseJapaneseWithMap('ア イ');
    expect(text).toBe('あい');
    expect(map).toEqual([0, 2, 3]);
    expect(endMap[1]).toBe(3);
  });
});

describe('time', () => {
  it('formats clocks', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(3_723_456)).toBe('1:02:03');
    expect(formatClock(3_723_456, { withMillis: true })).toBe('1:02:03.456');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
  it('parses clocks', () => {
    expect(parseClock('1:02:03.456')).toBe(3_723_456);
    expect(parseClock('02:03,5')).toBe(123_500);
    expect(parseClock('7')).toBe(7000);
    expect(parseClock('x')).toBeUndefined();
  });
});

describe('compareNatural', () => {
  it('orders digit runs numerically', () => {
    const list = ['p10.jpg', 'p2.jpg', 'P1.jpg', 'p02.jpg', 'cover.jpg', 'p１1.jpg'];
    expect([...list].sort(compareNatural)).toEqual(['cover.jpg', 'P1.jpg', 'p2.jpg', 'p02.jpg', 'p10.jpg', 'p１1.jpg']);
  });
  it('is total and antisymmetric', () => {
    expect(compareNatural('a', 'a')).toBe(0);
    expect(Math.sign(compareNatural('a1', 'a01'))).toBe(-Math.sign(compareNatural('a01', 'a1')));
    expect(compareNatural('Vol 9', 'Vol 10')).toBeLessThan(0);
    expect(compareNatural('99999999999999999999', '100000000000000000000')).toBeLessThan(0);
  });
});
