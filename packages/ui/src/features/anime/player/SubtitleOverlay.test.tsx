import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVtt, type SubtitleCue } from '@kotori/core';
import { DEFAULT_SETTINGS } from '../../../app/default-settings';
import { useSettingsStore } from '../../../stores/settings';
import { resetStores } from '../../../test/utils';
import { SubtitleOverlay } from './SubtitleOverlay';
import type { CueHighlight } from './useSubtitleBreakdown';

const playerCss = readFileSync(resolve(import.meta.dirname, './player.css'), 'utf8');
const NO_HL: CueHighlight = { span: undefined, focus: undefined, focusSpan: undefined, explaining: false };

function makeCue(index: number, text: string, ruby?: SubtitleCue['ruby']): SubtitleCue {
  return {
    index,
    startMs: 1000,
    endMs: 3000,
    text,
    rawText: text,
    ...(ruby ? { ruby } : {}),
  };
}

describe('SubtitleOverlay · inline <ruby> furigana', () => {
  beforeEach(() => {
    resetStores();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it('renders <ruby>/<rt> and adds .has-ruby on cues with ruby segments, omitting it on plain cues', () => {
    const cues: SubtitleCue[] = [
      makeCue(0, '漢字を読む', [
        { base: '漢字', ruby: 'かんじ', charSpan: [0, 2] },
        { base: '読', ruby: 'よ', charSpan: [3, 4] },
      ]),
      makeCue(1, 'ふつうのセリフ'),
    ];
    render(
      <SubtitleOverlay
        cues={cues}
        activeIndexes={[0, 1]}
        mergeKaraoke={false}
        blind={false}
        onCharClick={() => {}}
        highlightFor={() => NO_HL}
      />,
    );

    const rendered = screen.getAllByTestId('overlay-cue');
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveClass('has-ruby');
    expect(rendered[1]).not.toHaveClass('has-ruby');

    const rubies = rendered[0]!.querySelectorAll('ruby.k-ruby');
    expect(rubies).toHaveLength(2);
    expect(rubies[0]!.querySelector('rt')?.textContent).toBe('かんじ');
    expect(rubies[1]!.querySelector('rt')?.textContent).toBe('よ');
    expect(rendered[1]!.querySelectorAll('ruby')).toHaveLength(0);
  });

  it('rebases ruby onto primaryJa for bilingual cues while keeping inline secondary translation plain', () => {
    const cue = makeCue(0, '  漢字を読む\n阅读汉字', [
      { base: '漢字', ruby: 'かんじ', charSpan: [2, 4] },
      { base: '読', ruby: 'よ', charSpan: [5, 6] },
      { base: '阅读', ruby: 'yuedu', charSpan: [8, 10] },
    ]);
    const onCharClick = vi.fn();
    render(
      <SubtitleOverlay
        cues={[cue]}
        activeIndexes={[0]}
        mergeKaraoke={false}
        blind={false}
        onCharClick={onCharClick}
        highlightFor={() => NO_HL}
      />,
    );

    const line = screen.getByTestId('overlay-cue');
    expect(line).toHaveClass('has-ruby');
    const rubies = line.querySelectorAll('ruby.k-ruby');
    expect(rubies).toHaveLength(2);
    expect(rubies[0]).toHaveAttribute('data-char-start', '0');
    expect(rubies[0]).toHaveAttribute('data-char-end', '2');
    expect(rubies[1]).toHaveAttribute('data-char-start', '3');
    expect(rubies[1]).toHaveAttribute('data-char-end', '4');
    // Clicking <rt> on a bilingual cue reports the rebased primaryJa localCharIndex
    fireEvent.click(rubies[1]!.querySelector('rt')!);
    expect(onCharClick).toHaveBeenCalledWith(cue, 3);
    const secondary = line.querySelector('.k-sub-line__secondary');
    expect(secondary?.textContent).toBe('阅读汉字');
    expect(secondary?.querySelectorAll('ruby')).toHaveLength(0);
  });

  it('preserves and renders ruby segments when mergeKaraoke={true} merges typewriter cues', () => {
    const cues: SubtitleCue[] = [
      { index: 0, startMs: 0, endMs: 100, text: '漢', rawText: '<ruby>漢<rt>かん</rt></ruby>', ruby: [{ base: '漢', ruby: 'かん', charSpan: [0, 1] }] },
      { index: 1, startMs: 100, endMs: 200, text: '字', rawText: '<ruby>字<rt>じ</rt></ruby>', ruby: [{ base: '字', ruby: 'じ', charSpan: [0, 1] }] },
      { index: 2, startMs: 200, endMs: 300, text: 'だ', rawText: 'だ' },
    ];
    render(
      <SubtitleOverlay
        cues={cues}
        activeIndexes={[0]}
        mergeKaraoke={true}
        blind={false}
        onCharClick={() => {}}
        highlightFor={() => NO_HL}
      />,
    );
    const line = screen.getByTestId('overlay-cue');
    expect(line).toHaveClass('has-ruby');
    const rts = [...line.querySelectorAll('ruby.k-ruby rt')].map((el) => el.textContent);
    expect(rts).toEqual(['かん', 'じ']);
  });

  it('respects settings.anime.furiganaMode (all / tap / off) and reports exact char click offsets', () => {
    const cue = makeCue(0, '漢字を読む', [{ base: '漢字', ruby: 'かんじ', charSpan: [0, 2] }]);
    const onCharClick = vi.fn();

    const { rerender } = render(
      <SubtitleOverlay
        cues={[cue]}
        activeIndexes={[0]}
        mergeKaraoke={false}
        blind={false}
        onCharClick={onCharClick}
        highlightFor={() => NO_HL}
      />,
    );

    const rubyText = () => screen.getByTestId('overlay-cue').querySelector('.k-ruby-text')!;
    expect(rubyText()).toHaveAttribute('data-furigana', 'all');
    expect(rubyText()).not.toHaveClass('hide-ruby', 'is-ruby-tap');

    // Switch to 'off'
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, furiganaMode: 'off' } } });
    rerender(
      <SubtitleOverlay
        cues={[cue]}
        activeIndexes={[0]}
        mergeKaraoke={false}
        blind={false}
        onCharClick={onCharClick}
        highlightFor={() => NO_HL}
      />,
    );
    expect(rubyText()).toHaveAttribute('data-furigana', 'off');
    expect(rubyText()).toHaveClass('hide-ruby');

    // Switch to 'tap': tapping <ruby> reveals it AND fires onCharClick at the exact char index
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, furiganaMode: 'tap' } } });
    rerender(
      <SubtitleOverlay
        cues={[cue]}
        activeIndexes={[0]}
        mergeKaraoke={false}
        blind={false}
        onCharClick={onCharClick}
        highlightFor={() => NO_HL}
      />,
    );
    expect(rubyText()).toHaveAttribute('data-furigana', 'tap');
    expect(rubyText()).toHaveClass('is-ruby-tap');
    expect(rubyText()).not.toHaveClass('hide-ruby');

    const rubyEl = screen.getByTestId('overlay-cue').querySelector('ruby.k-ruby')!;
    const secondChar = rubyEl.querySelector('[data-char-start="1"]')!;
    fireEvent.click(secondChar);
    expect(rubyEl).toHaveClass('is-revealed');
    expect(onCharClick).toHaveBeenCalledWith(cue, 1);

    // Clicking <rt> maps to the ruby segment start
    fireEvent.click(rubyEl.querySelector('rt')!);
    expect(onCharClick).toHaveBeenLastCalledWith(cue, 0);
  });

  it('passes primaryRuby to line balancing so soft breaks never split inside a multi-kanji ruby segment', () => {
    const text = '今日は五百城茉央さんと歩きました';
    const cue = makeCue(0, text, [{ base: '五百城茉央', ruby: 'いおきまお', charSpan: [3, 8] }]);
    render(
      <SubtitleOverlay
        cues={[cue]}
        activeIndexes={[0]}
        mergeKaraoke={false}
        blind={false}
        onCharClick={() => {}}
        highlightFor={() => NO_HL}
        lineMetrics={{ primaryMaxEm: 10, secondaryMaxEm: 14, inlineSecondaryMaxEm: 14 }}
      />,
    );

    const breaks = [...screen.getByTestId('overlay-cue').querySelectorAll('br[data-soft-break]')].map((el) =>
      Number(el.getAttribute('data-soft-break')),
    );
    expect(breaks.length).toBeGreaterThan(0);
    for (const off of breaks) {
      expect(off <= 3 || off >= 8).toBe(true);
    }
  });

  it('safely renders VTT cues with untrusted tags as escaped text (no <script> or <img> DOM nodes)', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      '<img src=x onerror=alert(1)><ruby>漢字<rt><script>alert(2)</script>かんじ</rt></ruby>',
    ].join('\n');
    const parsed = parseVtt(vtt);
    const { container } = render(
      <SubtitleOverlay
        cues={parsed.cues}
        activeIndexes={[0]}
        mergeKaraoke={false}
        blind={false}
        onCharClick={() => {}}
        highlightFor={() => NO_HL}
      />,
    );

    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('ruby.k-ruby rt')?.textContent).toBe('alert(2)かんじ');
  });

  it('defines video-overlay ruby contrast, line-height, and hide-ruby display:none rules in player.css', () => {
    expect(playerCss).toMatch(/\.k-sub-line\s+\.k-ruby\s+rt\s*\{[^}]*font-size:\s*max\(9px,\s*0\.46em\)/);
    expect(playerCss).toMatch(/\.k-sub-line\.has-ruby:not\(:has\(\.hide-ruby\)\)\s*\{[^}]*line-height:\s*1\.78/);
    expect(playerCss).toMatch(/\.k-player--compact\s+\.k-sub-line\.has-ruby:not\(:has\(\.hide-ruby\)\)\s*\{[^}]*line-height:\s*1\.65/);
    expect(playerCss).toMatch(/\.k-player--immersive\s+\.k-sub-line\.has-ruby:not\(:has\(\.hide-ruby\)\)\s*\{[^}]*line-height:\s*1\.72/);
    expect(playerCss).toMatch(/\.k-sub-line\s+\.k-ruby-text\.hide-ruby\s+rt\s*\{[^}]*display:\s*none/);
  });
});
