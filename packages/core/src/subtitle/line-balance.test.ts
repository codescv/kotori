import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RubySegment } from '../types';
import { segmentGraphemes } from '../util/graphemes';
import {
  balanceSubtitleLines,
  computeBalancedBreakOffsets,
  measureSubtitleEm,
} from './line-balance';

const hasWordSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

describe('line-balance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('measureSubtitleEm (§2.2)', () => {
    it('measures CJK, halfwidth kana, combining/newlines, and Noto Sans JP Latin classes accurately', () => {
      expect(measureSubtitleEm('')).toBe(0);
      expect(measureSubtitleEm('あ漢、。「」　…—')).toBeCloseTo(9.0, 6);
      expect(measureSubtitleEm('ｶﾀｶﾅ')).toBeCloseTo(2.0, 6);
      expect(measureSubtitleEm('あ\nい\u200b\ufeff')).toBeCloseTo(2.0, 6);
      expect(measureSubtitleEm(' ')).toBeCloseTo(0.28, 6);
      expect(measureSubtitleEm('il.!()')).toBeCloseTo(6 * 0.32, 6);
      expect(measureSubtitleEm('mwMW@%&')).toBeCloseTo(7 * 0.9, 6);
      expect(measureSubtitleEm('ABC')).toBeCloseTo(3 * 0.72, 6);
      expect(measureSubtitleEm('123')).toBeCloseTo(3 * 0.6, 6);
      expect(measureSubtitleEm('abc')).toBeCloseTo(3 * 0.56, 6);
    });
  });

  describe('worked examples (§2.7, maxLineEm = 12)', () => {
    it('row 1: balances after bunsetsu particle に instead of early は or kinsoku-invalid tail', () => {
      expect(balanceSubtitleLines('今日は本当に楽しかったね。', 12)).toBe('今日は本当に\n楽しかったね。');
    });

    it.skipIf(!hasWordSegmenter)('row 2: keeps katakana run intact and breaks at ライブハウスに｜行って…', () => {
      const out = balanceSubtitleLines('ライブハウスに行ってみたいんだけど。', 12);
      expect(['ライブハウスに\n行ってみたいんだけど。', 'ライブハウスに行って\nみたいんだけど。']).toContain(out);
      expect(out).toBe('ライブハウスに\n行ってみたいんだけど。');
    });

    it('row 3: respects quotes kinsoku and 3b ん attachment', () => {
      expect(balanceSubtitleLines('「そんなこと言われても困るんだよね。」', 12)).toBe(
        '「そんなこと言われても\n困るんだよね。」',
      );
    });

    it.skipIf(!hasWordSegmenter)('row 4: balances pure-kana line without splitting いっちゃった or ん', () => {
      const out = balanceSubtitleLines('なんでそんなこといっちゃったんだろうなあ', 12);
      expect([
        'なんでそんなこと\nいっちゃったんだろうなあ',
        'なんでそんな\nこといっちゃったんだろうなあ',
      ]).toContain(out);
      expect(out).toBe('なんでそんなこと\nいっちゃったんだろうなあ');
    });

    it('row 5: leaves lines that fit maxLineEm untouched, and never starts a line with ……', () => {
      expect(balanceSubtitleLines('食べちゃった。もう無理…', 12)).toBe('食べちゃった。もう無理…');
      expect(balanceSubtitleLines('食べちゃった。もう無理……', 13)).toBe('食べちゃった。もう無理……');
      expect(balanceSubtitleLines('食べちゃった。もう無理……', 12)).toBe('食べちゃった。\nもう無理……');
    });

    it('row 6: prefers balanced bunsetsu break over unbalanced clause break while protecting …… and ちゃった', () => {
      expect(balanceSubtitleLines('食べちゃった。もう本当に無理……だってさ', 12)).toBe(
        '食べちゃった。もう本当に\n無理……だってさ',
      );
    });

    it('row 7: joins orphan second line (本当に楽しかった\\nね。) into a single line when it fits, or re-balances cleanly', () => {
      const planFit = computeBalancedBreakOffsets('本当に楽しかった\nね。', 12);
      expect([...planFit.joinedHardBreaks]).toEqual([8]);
      expect([...planFit.softBreaks]).toEqual([]);
      expect(balanceSubtitleLines('本当に楽しかった\nね。', 12)).toBe('本当に楽しかったね。');

      const planWrap = computeBalancedBreakOffsets('本当に楽しかった\nね。', 8);
      expect([...planWrap.joinedHardBreaks]).toEqual([8]);
      expect([...planWrap.softBreaks]).toEqual([3]);
      expect(balanceSubtitleLines('本当に楽しかった\nね。', 8)).toBe('本当に\n楽しかったね。');
    });

    it('row 8: leaves speaker-dash dialogue cues untouched', () => {
      expect(balanceSubtitleLines('- 行くの？\n- うん', 12)).toBe('- 行くの？\n- うん');
    });

    it.skipIf(!hasWordSegmenter)('row 9: balances Chinese subtitle at word boundary near midpoint', () => {
      const out = balanceSubtitleLines('我觉得这件事情还是应该再考虑一下比较好', 12);
      expect([
        '我觉得这件事情还是\n应该再考虑一下比较好',
        '我觉得这件事情\n还是应该再考虑一下比较好',
      ]).toContain(out);
      expect(out).toBe('我觉得这件事情还是\n应该再考虑一下比较好');
    });

    it('row 10: skips Latin-dominant paragraphs (CJK share < 50 %) so CSS text-wrap: balance handles them', () => {
      const en = 'I think we should probably talk about it later tonight';
      const plan = computeBalancedBreakOffsets(en, 12);
      expect(plan.softBreaks.size).toBe(0);
      expect(plan.joinedHardBreaks.size).toBe(0);
      expect(balanceSubtitleLines(en, 12)).toBe(en);
    });
  });

  describe('constraints & properties (§2.8)', () => {
    it('returns empty plan for Infinity, NaN, <= 0 maxLineEm, or empty string', () => {
      const sample = '今日は本当に楽しかったね。';
      for (const maxEm of [Infinity, Number.NaN, 0, -10]) {
        const plan = computeBalancedBreakOffsets(sample, maxEm);
        expect(plan.softBreaks.size).toBe(0);
        expect(plan.joinedHardBreaks.size).toBe(0);
        expect(balanceSubtitleLines(sample, maxEm)).toBe(sample);
      }
      expect(computeBalancedBreakOffsets('', 10).softBreaks.size).toBe(0);
    });

    it('preserves single-line rendering whenever T === maxLineEm exactly', () => {
      for (let len = 1; len <= 30; len++) {
        const s = 'あ'.repeat(len);
        expect(measureSubtitleEm(s)).toBe(len);
        expect(computeBalancedBreakOffsets(s, len).softBreaks.size).toBe(0);
        expect(balanceSubtitleLines(s, len)).toBe(s);
      }
    });

    it('property: 200 random kana/kanji strings (7–40 chars) never produce < 3-grapheme lines, invalid offsets, or text mutation', () => {
      const alphabet = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもっゃゅょー今日私学校先生友達元気本当楽、。「」！？'];
      // Deterministic xorshift32 PRNG.
      let seed = 0x12345678;
      const nextInt = (bound: number): number => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) % bound;
      };

      for (let trial = 0; trial < 200; trial++) {
        const len = 7 + nextInt(34); // 7..40
        let s = '';
        for (let i = 0; i < len; i++) {
          s += alphabet[nextInt(alphabet.length)]!;
        }
        for (const maxLineEm of [10, 13, 16]) {
          const plan = computeBalancedBreakOffsets(s, maxLineEm);
          const graphemes = segmentGraphemes(s);
          const validStarts = new Set(graphemes.map((g) => g.start));

          let prevOff = -1;
          for (const off of plan.softBreaks) {
            expect(validStarts.has(off)).toBe(true);
            expect(off).toBeGreaterThan(prevOff);
            expect(off).toBeGreaterThan(0);
            expect(off).toBeLessThan(s.length);
            prevOff = off;
          }

          const balanced = balanceSubtitleLines(s, maxLineEm);
          expect(balanced.replace(/\n/g, '')).toBe(s.replace(/\n/g, ''));

          const T = measureSubtitleEm(s);
          // Whenever within the 3-line budget (not forced into greedy overflow), every line has >= 3 graphemes.
          if (plan.softBreaks.size > 0 && T <= 3 * maxLineEm) {
            for (const line of balanced.split('\n')) {
              expect(segmentGraphemes(line).length).toBeGreaterThanOrEqual(3);
            }
          }
        }
      }
    });

    it('never starts a line with any KINSOKU_START character', () => {
      const kinsokuStart =
        '、。，．・：；！？!?,.:;)）」』】〉》〕｝］”’%％ー〜～…‥っゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞヽヾ';
      for (const ch of kinsokuStart) {
        const s = `あいうえお${ch}かきくけこ`;
        const balanced = balanceSubtitleLines(s, 6);
        for (const line of balanced.split('\n').slice(1)) {
          expect(line.startsWith(ch)).toBe(false);
        }
      }
    });

    it('never ends a line immediately after any KINSOKU_END character', () => {
      const kinsokuEnd = '（(「『【〈《〔｛［[“‘"\'＄$￥¥#＃';
      for (const ch of kinsokuEnd) {
        const s = `あいうえお${ch}かきくけこ`;
        const balanced = balanceSubtitleLines(s, 6);
        for (const line of balanced.split('\n').slice(0, -1)) {
          expect(line.endsWith(ch)).toBe(false);
        }
      }
    });

    it('never splits katakana runs, ASCII words, decimals/thousands, digit+counters, or intra-word hyphens', () => {
      // Katakana run
      const kata = balanceSubtitleLines('昨日ライブハウスで歌ったよ', 8);
      expect(kata).not.toMatch(/ラ\n|イ\n|ブ\n|ハ\n|ウ\n/);

      // ASCII word inside CJK-dominant line
      const mixed = balanceSubtitleLines('今日はLIVEハウスに行ったよ', 8);
      expect(mixed).not.toMatch(/L\n|I\n|V\n/);

      // Decimal & comma numbers
      const dec = balanceSubtitleLines('円周率は約3.1415だよな', 7);
      expect(dec).not.toMatch(/3\n|\.\n|3\.\n/);
      const num = balanceSubtitleLines('値段はなんと1,200円だった', 8);
      expect(num).not.toMatch(/1\n|,\n|1,\n|0\n円/);

      // Digit + kanji / katakana counter
      expect(balanceSubtitleLines('そこにはちょうど３人いたんだよ', 8)).not.toContain('３\n人');
      expect(balanceSubtitleLines('ここからだいたい２キロあるよ', 8)).not.toContain('２\nキロ');
      expect(balanceSubtitleLines('あとちょうど3ヶ月かかるよ', 8)).not.toContain('3\nヶ');

      // Intra-word hyphen
      expect(balanceSubtitleLines('私はよくJ-POPを聴くんだよ', 8)).not.toMatch(/J\n|-\n/);
    });

    it('never splits strictly inside a RubySegment with ruby, while allowing breaks outside or at boundaries', () => {
      const text = '今日は図書館へ行ったよ';
      // 図書館 is [3, 6)
      const segments: RubySegment[] = [{ base: '図書館', ruby: 'としょかん', charSpan: [3, 6] }];
      const plan = computeBalancedBreakOffsets(text, 6, { segments });
      expect(plan.softBreaks.has(4)).toBe(false);
      expect(plan.softBreaks.has(5)).toBe(false);
      expect(plan.softBreaks.size).toBeGreaterThan(0);
    });

    it('enforces §2.3-3b AUX attachment at every tier (with and without Intl.Segmenter), while keeping 明日は｜たぶん legal', () => {
      const checkAuxProtected = () => {
        expect(balanceSubtitleLines('つい全部食べちゃったよね', 7)).not.toMatch(/食べ\nちゃった|ちゃっ\nた/);
        expect(balanceSubtitleLines('そんなふうに言われて困る', 7)).not.toContain('言わ\nれて');
        expect(balanceSubtitleLines('そんなこと言われても困るんだ', 9)).not.toContain('困る\nんだ');
        expect(balanceSubtitleLines('昨日は全然寝なかったんだよ', 8)).not.toContain('寝\nなかった');
        expect(balanceSubtitleLines('今日はもう食べましたよね', 8)).not.toContain('食べ\nました');
      };

      checkAuxProtected();

      // Segmenter escape: 明日は｜たぶん and でも｜だから allow breaking before the multi-char adverb/conjunction.
      if (hasWordSegmenter) {
        expect(balanceSubtitleLines('明日はたぶんいい', 5)).toBe('明日は\nたぶんいい');
        expect(balanceSubtitleLines('やっぱりでもだから困る', 6)).toBe('やっぱりでも\nだから困る');
      }

      // Without Intl.Segmenter: 3b still protects AUX unconditionally and Tier 4/4b still balance cleanly.
      vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
      checkAuxProtected();
      expect(balanceSubtitleLines('今日は本当に楽しかったね。', 12)).toBe('今日は本当に\n楽しかったね。');
      expect(balanceSubtitleLines('我觉得这件事情还是应该再考虑一下比较好', 12).split('\n')).toHaveLength(2);
    });

    it('does not treat この/その/あの/どの/こんな/そんな or compound verbs (話し合う) as Tier-2 bunsetsu splits', () => {
      expect(balanceSubtitleLines('やっぱりこの本が一番面白いよ', 8)).not.toContain('この\n本');
      if (hasWordSegmenter) {
        expect(balanceSubtitleLines('みんなで話し合う必要があるよ', 8)).not.toContain('話し\n合う');
      }
    });

    it('collapses multiple spaces to a single break opportunity AFTER the spaces and hangs trailing space (0 em)', () => {
      // '今日は少し' (5 em) + '  ' (hangs as 0 em on line 1) + 'とてもいい' (5 em):
      // even at maxLineEm = 5, line 1 fits ('今日は少し  ' = 5 em <= 5) and breaks at index 7 ('と'), never 5 or 6.
      const s = '今日は少し  とてもいい';
      const plan = computeBalancedBreakOffsets(s, 5);
      expect([...plan.softBreaks]).toEqual([7]);
    });

    it('verifies every §2.4 orphan-join guard individually', () => {
      // 3-line cue (m === 3) -> never joined
      expect(computeBalancedBreakOffsets('あいうえお\nかきくけこ\nね。', 20).joinedHardBreaks.size).toBe(0);
      // Non-orphan L2 (> 2 graphemes and > 2.5 em) -> not joined
      expect(computeBalancedBreakOffsets('本当に楽しかった\nだよね。', 20).joinedHardBreaks.size).toBe(0);
      // Terminal punctuation on L1 -> not joined
      expect(computeBalancedBreakOffsets('今日は楽しかった。\nね', 20).joinedHardBreaks.size).toBe(0);
      // Opener on L2 -> not joined
      expect(computeBalancedBreakOffsets('行くよ\n「うん」', 20).joinedHardBreaks.size).toBe(0);
      // Leading whitespace on L2 -> not joined
      expect(computeBalancedBreakOffsets('行くよ\n うん', 20).joinedHardBreaks.size).toBe(0);
      // Latin pair -> never joined (would glue words: you\nOK -> youOK)
      expect(computeBalancedBreakOffsets('Are you\nOK', 20).joinedHardBreaks.size).toBe(0);
      expect(balanceSubtitleLines('Are you\nOK', 20)).toBe('Are you\nOK');
      expect(computeBalancedBreakOffsets('本当に\nOK', 20).joinedHardBreaks.size).toBe(0);
    });

    it('uses greedy kinsoku-safe fallback A when T > maxLines * maxLineEm, and handles LRU eviction cleanly', () => {
      const veryLong = '今日は本当に楽しかったし明日もきっと素晴らしい一日になるよね、みんなで行こうよ！';
      const out = balanceSubtitleLines(veryLong, 9, { maxLines: 3 });
      const lines = out.split('\n');
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) {
        expect(measureSubtitleEm(line)).toBeLessThanOrEqual(9);
        expect(line.startsWith('、')).toBe(false);
        expect(line.startsWith('！')).toBe(false);
      }

      // Exercise > 64 distinct keys in the LRU cache and verify cache hit consistency.
      for (let i = 0; i < 80; i++) {
        const res = balanceSubtitleLines(`テスト用の字幕テキスト番号${i}ですけれども長めにする`, 10);
        expect(res).toContain('\n');
      }
      expect(balanceSubtitleLines('今日は本当に楽しかったね。', 12)).toBe('今日は本当に\n楽しかったね。');
    });
  });
});
