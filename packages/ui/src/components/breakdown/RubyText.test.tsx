import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RubySegment } from '@kotori/core';
import { DEFAULT_SETTINGS } from '../../app/default-settings';
import { useSettingsStore } from '../../stores/settings';
import { glyphAt, resetStores } from '../../test/utils';
import { RubyText, inferWordSpanAt, tileSegments } from './RubyText';

const SENTENCE = '食べてんじゃねぇよ！';
const RUBY: RubySegment[] = [
  { base: '食', ruby: 'た', charSpan: [0, 1] },
  { base: 'べてんじゃねぇよ！', charSpan: [1, 10] },
];

describe('RubyText', () => {
  it('renders <ruby>base<rt>reading</rt></ruby> with data-char-start/end attributes', () => {
    const { container } = render(<RubyText text={SENTENCE} segments={RUBY} />);
    const ruby = container.querySelector('ruby');
    expect(ruby).not.toBeNull();
    expect(ruby?.getAttribute('data-char-start')).toBe('0');
    expect(ruby?.getAttribute('data-char-end')).toBe('1');
    expect(ruby?.querySelector('rt')?.textContent).toBe('た');
    // Every UTF-16 position is addressable.
    for (let i = 0; i < SENTENCE.length; i++) expect(glyphAt(container, i).textContent).toBe(SENTENCE[i]);
  });

  it('maps a character click to its exact UTF-16 charIndex', () => {
    const onCharClick = vi.fn();
    const { container } = render(<RubyText text={SENTENCE} segments={RUBY} onCharClick={onCharClick} />);
    fireEvent.click(glyphAt(container, 4));
    expect(onCharClick).toHaveBeenLastCalledWith(4);
    fireEvent.click(glyphAt(container, 0));
    expect(onCharClick).toHaveBeenLastCalledWith(0);
  });

  it('maps a click on the reading (<rt>) to the segment start', () => {
    const onCharClick = vi.fn();
    const { container } = render(<RubyText text="今日は晴れ" segments={[{ base: '今日', ruby: 'きょう', charSpan: [0, 2] }, { base: 'は', charSpan: [2, 3] }, { base: '晴', ruby: 'は', charSpan: [3, 4] }, { base: 'れ', charSpan: [4, 5] }]} onCharClick={onCharClick} />);
    const rts = container.querySelectorAll('rt');
    fireEvent.click(rts[1] as Element);
    expect(onCharClick).toHaveBeenLastCalledWith(3);
    // Second kanji of a multi-char base keeps its own index.
    fireEvent.click(glyphAt(container, 1));
    expect(onCharClick).toHaveBeenLastCalledWith(1);
  });

  it('uses UTF-16 offsets for astral characters (surrogate pairs)', () => {
    const onCharClick = vi.fn();
    const text = '𠮷野家で食べる';
    const { container } = render(<RubyText text={text} onCharClick={onCharClick} />);
    fireEvent.click(glyphAt(container, 2)); // 野 sits after the 2-unit 𠮷
    expect(onCharClick).toHaveBeenLastCalledWith(2);
    expect(glyphAt(container, 0).getAttribute('data-char-end')).toBe('2');
  });

  it('highlights the active span and the focused character', () => {
    const { container } = render(<RubyText text={SENTENCE} segments={RUBY} highlight={[2, 8]} focusIndex={3} />);
    expect(glyphAt(container, 1)).not.toHaveClass('is-hl');
    expect(glyphAt(container, 2)).toHaveClass('is-hl', 'is-hl-start');
    expect(glyphAt(container, 7)).toHaveClass('is-hl', 'is-hl-end');
    expect(glyphAt(container, 8)).not.toHaveClass('is-hl');
    expect(glyphAt(container, 3)).toHaveClass('is-focus');
  });

  it('highlights the entire katakana word ("ライブハウス") when any kana inside it is focused', () => {
    const text = 'ライブハウスで演奏する';
    for (let idx = 0; idx < 6; idx++) {
      expect(inferWordSpanAt(text, idx)).toEqual([0, 6]);
      const { container, unmount } = render(<RubyText text={text} focusIndex={idx} />);
      for (let g = 0; g < 6; g++) {
        expect(glyphAt(container, g)).toHaveClass('is-focus');
      }
      expect(glyphAt(container, 0)).toHaveClass('is-focus-start');
      expect(glyphAt(container, 0)).not.toHaveClass('is-focus-end');
      expect(glyphAt(container, 3)).not.toHaveClass('is-focus-start');
      expect(glyphAt(container, 3)).not.toHaveClass('is-focus-end');
      expect(glyphAt(container, 5)).toHaveClass('is-focus-end');
      expect(glyphAt(container, 5)).not.toHaveClass('is-focus-start');
      expect(glyphAt(container, 6)).not.toHaveClass('is-focus');
      unmount();
    }
  });

  it('highlights compound kanji and ruby words (e.g. clicking 子 in 女子 highlights both 女 and 子)', () => {
    const text = 'バンドの女子が歌う';
    const segs: RubySegment[] = [
      { base: 'バンドの', charSpan: [0, 4] },
      { base: '女子', ruby: 'じょし', charSpan: [4, 6] },
      { base: 'が', charSpan: [6, 7] },
      { base: '歌', ruby: 'うた', charSpan: [7, 8] },
      { base: 'う', charSpan: [8, 9] },
    ];
    expect(inferWordSpanAt(text, 5, segs)).toEqual([4, 6]);
    const { container } = render(<RubyText text={text} segments={segs} focusIndex={5} />);
    expect(glyphAt(container, 3)).not.toHaveClass('is-focus');
    expect(glyphAt(container, 4)).toHaveClass('is-focus', 'is-focus-start');
    expect(glyphAt(container, 5)).toHaveClass('is-focus', 'is-focus-end');
    expect(glyphAt(container, 6)).not.toHaveClass('is-focus');
  });

  it('renders a slice of a longer sentence with an offset (chunk cards)', () => {
    const onCharClick = vi.fn();
    const { container } = render(<RubyText text="てんじゃねぇ" segments={RUBY} offset={2} onCharClick={onCharClick} />);
    fireEvent.click(glyphAt(container, 4));
    expect(onCharClick).toHaveBeenLastCalledWith(4);
    expect(container.querySelector('rt')).toBeNull();
  });

  it('tileSegments fills gaps so bases always reproduce the text', () => {
    const segs = tileSegments('ABCDEF', [{ base: 'CD', ruby: 'x', charSpan: [2, 4] }]);
    expect(segs.map((s) => s.base).join('')).toBe('ABCDEF');
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
  });

  describe('furiganaMode (settings.anime.furiganaMode)', () => {
    beforeEach(resetStores);
    const setMode = (furiganaMode: 'all' | 'off' | 'tap'): void =>
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, furiganaMode } } });

    it("'all' (default) shows readings", () => {
      const { container } = render(<RubyText text={SENTENCE} segments={RUBY} />);
      expect(container.querySelector('.k-ruby-text')).not.toHaveClass('hide-ruby');
      expect(container.querySelector('.k-ruby-text')).not.toHaveClass('is-ruby-tap');
    });

    it("'off' hides <rt> readings but keeps hit mapping", () => {
      setMode('off');
      const onCharClick = vi.fn();
      const { container } = render(<RubyText text={SENTENCE} segments={RUBY} onCharClick={onCharClick} />);
      expect(container.querySelector('.k-ruby-text')).toHaveClass('hide-ruby');
      fireEvent.click(glyphAt(container, 0));
      expect(onCharClick).toHaveBeenLastCalledWith(0);
    });

    it("'tap' veils readings until that word is tapped", () => {
      setMode('tap');
      const onCharClick = vi.fn();
      const { container } = render(<RubyText text={SENTENCE} segments={RUBY} onCharClick={onCharClick} />);
      expect(container.querySelector('.k-ruby-text')).toHaveClass('is-ruby-tap');
      const ruby = container.querySelector('ruby');
      expect(ruby).not.toHaveClass('is-revealed');
      fireEvent.click(glyphAt(container, 0));
      expect(ruby).toHaveClass('is-revealed');
      expect(onCharClick).toHaveBeenLastCalledWith(0);
    });
  });

  describe('softBreakOffsets & joinHardBreakOffsets (§3 zero-index-shift)', () => {
    it('emits br.k-ruby-text__wbr before the target glyph with zero shift to data-char-start/end and click indices', () => {
      const onCharClick = vi.fn();
      const plain = render(<RubyText text={SENTENCE} segments={RUBY} />);
      const plainSpans = [...plain.container.querySelectorAll('[data-glyph]')].map((el) => [
        el.getAttribute('data-char-start'),
        el.getAttribute('data-char-end'),
      ]);
      plain.unmount();

      const { container } = render(
        <RubyText
          text={SENTENCE}
          segments={RUBY}
          softBreakOffsets={new Set([0, 5])}
          onCharClick={onCharClick}
        />,
      );

      // Offset 0 (firstSegStart) is ignored; only offset 5 produces a soft <br>.
      const wbrs = container.querySelectorAll('br.k-ruby-text__wbr');
      expect(wbrs).toHaveLength(1);
      const wbr = wbrs[0] as HTMLElement;
      expect(wbr.getAttribute('data-soft-break')).toBe('5');
      expect(wbr.getAttribute('data-char-start')).toBe('5');
      expect(wbr.getAttribute('data-char-end')).toBe('5');
      expect(glyphAt(container, 5).previousElementSibling).toBe(wbr);

      // [data-glyph] coordinate list is 100% identical to the no-break render.
      const wrappedSpans = [...container.querySelectorAll('[data-glyph]')].map((el) => [
        el.getAttribute('data-char-start'),
        el.getAttribute('data-char-end'),
      ]);
      expect(wrappedSpans).toEqual(plainSpans);

      // Clicking glyph 5 (first char on line 2), glyph 8, or the <br> itself maps accurately.
      fireEvent.click(glyphAt(container, 5));
      expect(onCharClick).toHaveBeenLastCalledWith(5);
      fireEvent.click(glyphAt(container, 8));
      expect(onCharClick).toHaveBeenLastCalledWith(8);
      fireEvent.click(wbr);
      expect(onCharClick).toHaveBeenLastCalledWith(5);
    });

    it('emits segment-level soft <br> as a sibling before <ruby> and never emits <br> inside <ruby>', () => {
      const text = 'バンドの女子が歌う';
      const segs: RubySegment[] = [
        { base: 'バンドの', charSpan: [0, 4] },
        { base: '女子', ruby: 'じょし', charSpan: [4, 6] },
        { base: 'が', charSpan: [6, 7] },
      ];
      const onCharClick = vi.fn();

      // Break at 4 (start of <ruby>) + defensive attempt at 5 (inside <ruby>).
      const { container } = render(
        <RubyText
          text={text}
          segments={segs}
          softBreakOffsets={new Set([4, 5])}
          onCharClick={onCharClick}
        />,
      );

      const ruby = container.querySelector('ruby[data-char-start="4"]');
      expect(ruby).not.toBeNull();
      expect(ruby?.querySelectorAll('br')).toHaveLength(0);

      const wbrs = container.querySelectorAll('br.k-ruby-text__wbr');
      expect(wbrs).toHaveLength(1);
      expect(ruby?.previousElementSibling).toBe(wbrs[0]);
      expect(wbrs[0]?.getAttribute('data-soft-break')).toBe('4');

      fireEvent.click(glyphAt(container, 4));
      expect(onCharClick).toHaveBeenLastCalledWith(4);
      fireEvent.click(glyphAt(container, 5));
      expect(onCharClick).toHaveBeenLastCalledWith(5);
    });

    it('turns joined hard-break \\n into span.k-glyph--joined without data-glyph while preserving subsequent offsets', () => {
      const onCharClick = vi.fn();
      const text = '本当に楽しかった\nね。';
      const { container } = render(
        <RubyText
          text={text}
          softBreakOffsets={new Set([3])}
          joinHardBreakOffsets={new Set([8])}
          onCharClick={onCharClick}
        />,
      );

      // Only the soft break at 3 is a <br>; the \n at 8 is an inline joined marker without data-glyph.
      const brs = container.querySelectorAll('br');
      expect(brs).toHaveLength(1);
      expect(brs[0]).toHaveClass('k-ruby-text__wbr');
      expect(brs[0]?.getAttribute('data-soft-break')).toBe('3');

      const joined = container.querySelector('span.k-glyph--joined');
      expect(joined).not.toBeNull();
      expect(joined?.hasAttribute('data-glyph')).toBe(false);
      expect(joined?.getAttribute('data-char-start')).toBe('8');
      expect(joined?.getAttribute('data-char-end')).toBe('9');
      expect(joined?.getAttribute('aria-hidden')).toBe('true');

      // 'ね' is still at UTF-16 index 9 and '。' at 10.
      expect(glyphAt(container, 9).textContent).toBe('ね');
      expect(glyphAt(container, 10).textContent).toBe('。');
      fireEvent.click(glyphAt(container, 9));
      expect(onCharClick).toHaveBeenLastCalledWith(9);
    });
  });
});
