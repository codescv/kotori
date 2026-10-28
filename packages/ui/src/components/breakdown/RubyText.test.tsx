import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RubySegment } from '@kotori/core';
import { DEFAULT_SETTINGS } from '../../app/default-settings';
import { useSettingsStore } from '../../stores/settings';
import { glyphAt, resetStores } from '../../test/utils';
import { RubyText, tileSegments } from './RubyText';

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
});
