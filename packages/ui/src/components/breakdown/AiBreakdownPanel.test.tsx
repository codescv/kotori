import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpMessage, SentenceExplanation } from '@kotori/core';
import { DEFAULT_SETTINGS } from '../../app/default-settings';
import { explanationFor } from '../../host/mock/explanations';
import { createTranslator } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { glyphAt, resetStores } from '../../test/utils';
import { AiBreakdownPanel } from './AiBreakdownPanel';
import { FollowUpThread, renderLight } from './FollowUpThread';
import { kanaToRomaji } from './romaji';
import { deriveSelection } from './useBreakdownSelection';

const t = createTranslator('zh-CN');
const EXPL = explanationFor('食べてんじゃねぇよ！', 'zh-CN');

function Harness({ explanation, initial }: { readonly explanation: SentenceExplanation; readonly initial?: number }) {
  const [focus, setFocus] = useState<number | undefined>(initial);
  return (
    <>
      <output data-testid="focus">{focus ?? ''}</output>
      <AiBreakdownPanel explanation={explanation} focusCharIndex={focus} onFocusChange={setFocus} t={t} />
    </>
  );
}

const sentence = (): HTMLElement => screen.getByTestId('breakdown-sentence');

describe('AiBreakdownPanel – bidirectional chunk highlight', () => {
  beforeEach(resetStores);

  it('fixture sanity: chunk spans index the verbatim sentence', () => {
    expect(EXPL.chunks.map((c) => EXPL.sentence.slice(c.charSpan[0], c.charSpan[1]))).toEqual(['食べ', 'てんじゃねぇ', 'よ']);
    expect(EXPL.chunks[1]?.spokenEvolution?.derivation).toContain('ているのではない');
  });

  it('sentence char click → highlights the owning chunk card (and its span)', () => {
    render(<Harness explanation={EXPL} />);
    fireEvent.click(glyphAt(sentence(), 4)); // じ inside てんじゃねぇ [2,8)
    expect(screen.getByTestId('focus').textContent).toBe('4');
    expect(screen.getByTestId('chunk-c1')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('chunk-c0')).not.toHaveAttribute('aria-current');
    expect(glyphAt(sentence(), 2)).toHaveClass('is-hl');
    expect(glyphAt(sentence(), 7)).toHaveClass('is-hl');
    expect(glyphAt(sentence(), 1)).not.toHaveClass('is-hl');
    // 📘 textbook form + 🔥 spoken evolution shown on the card
    expect(screen.getByTestId('chunk-c1').textContent).toContain('ているのではない');
    expect(screen.getByTestId('chunk-c1').textContent).toContain('🔥');
  });

  it('chunk card click → reverse-highlights the span in the sentence', () => {
    render(<Harness explanation={EXPL} />);
    fireEvent.click(screen.getByTestId('chunk-c2'));
    expect(screen.getByTestId('focus').textContent).toBe('8');
    expect(glyphAt(sentence(), 8)).toHaveClass('is-hl', 'is-hl-start', 'is-hl-end');
    expect(glyphAt(sentence(), 4)).not.toHaveClass('is-hl');
    expect(screen.getByTestId('chunk-c2')).toHaveAttribute('aria-current', 'true');
  });

  it('switching characters within the same sentence is synchronous (0 ms)', () => {
    render(<Harness explanation={EXPL} initial={0} />);
    expect(screen.getByTestId('chunk-c0')).toHaveAttribute('aria-current', 'true');
    // No awaiting: the very next assertion after the click must already see the change.
    act(() => {
      fireEvent.click(glyphAt(sentence(), 6));
    });
    expect(screen.getByTestId('chunk-c1')).toHaveAttribute('aria-current', 'true');
  });

  it('punctuation between/after chunks resolves to the nearest chunk (right, else left)', () => {
    render(<Harness explanation={EXPL} />);
    fireEvent.click(glyphAt(sentence(), 9)); // ！ after the last chunk
    expect(screen.getByTestId('chunk-c2')).toHaveAttribute('aria-current', 'true');
  });

  it('vocab and grammar linked to the focused chunk are highlighted', () => {
    render(<Harness explanation={EXPL} initial={3} />);
    fireEvent.click(screen.getByRole('tab', { name: /词汇/ }));
    expect(screen.getByTestId('vocab-v1')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('vocab-v0')).not.toHaveAttribute('aria-current');
    // Pitch accent is intentionally not rendered (unreliable model output).
    expect(screen.getByTestId('vocab-v0').textContent).not.toContain('②');
    expect(screen.getByTestId('vocab-v0').querySelector('.k-vocab__pitch')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /语法/ }));
    expect(screen.getByTestId('grammar-g0')).toHaveAttribute('aria-current', 'true');
  });

  it('deriveSelection: no focus → nothing highlighted', () => {
    expect(deriveSelection(EXPL, undefined).activeChunk).toBeUndefined();
    expect(deriveSelection(EXPL, 0).activeChunk?.id).toBe('c0');
    expect([...deriveSelection(EXPL, 2).linkedVocabIds]).toEqual(['v1']);
  });

  it('renders manga bubble crop preview, cultural note card, audio slice replay, and TTS buttons', () => {
    let replayed = false;
    const withCultural: SentenceExplanation = {
      ...EXPL,
      culturalNote: '下北沢（しもきたざわ）是东京著名的独立摇滚与 Livehouse 圣地。',
    };
    render(
      <AiBreakdownPanel
        explanation={withCultural}
        focusCharIndex={0}
        onFocusChange={() => {}}
        onReplayAudio={() => {
          replayed = true;
        }}
        bubblePreview={{
          imageUrl: '/page-1.jpg',
          pageWidth: 800,
          pageHeight: 1200,
          rect: { left: 100, top: 200, right: 260, bottom: 420 },
        }}
        t={t}
      />,
    );
    expect(screen.getByTestId('breakdown-bubble-crop')).toBeInTheDocument();
    expect(screen.getByTestId('breakdown-cultural-note')).toHaveTextContent('下北沢');
    expect(screen.getByTestId('breakdown-tts-sentence')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('breakdown-replay-audio'));
    expect(replayed).toBe(true);
  });
});

describe('AiBreakdownPanel – compaction, notices, shadowing', () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('drops reading lines equal to the surface and textbook rows equal to the surface', () => {
    render(<AiBreakdownPanel explanation={EXPL} focusCharIndex={undefined} onFocusChange={() => {}} t={t} />);
    // 食べ → たべ differs: shown. てんじゃねぇ / よ are pure kana: hidden.
    expect(screen.getByTestId('chunk-reading-c0')).toHaveTextContent('たべ');
    expect(screen.queryByTestId('chunk-reading-c1')).toBeNull();
    expect(screen.queryByTestId('chunk-reading-c2')).toBeNull();
    // c1 keeps its 📘 row (ているのではない ≠ てんじゃねぇ); c2 (よ = よ, no evolution) loses it.
    expect(screen.getByTestId('chunk-c1').textContent).toContain('📘');
    expect(screen.getByTestId('chunk-c2').textContent).not.toContain('📘');
  });

  it('shows romaji only with settings.anime.showRomaji', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, anime: { ...DEFAULT_SETTINGS.anime, showRomaji: true } } });
    render(<AiBreakdownPanel explanation={EXPL} focusCharIndex={undefined} onFocusChange={() => {}} t={t} />);
    expect(screen.getByTestId('chunk-reading-c0')).toHaveTextContent('tabe');
    expect(screen.getByTestId('chunk-reading-c1')).toHaveTextContent('tenjanee');
    expect(kanaToRomaji('ちょっと')).toBe('chotto');
    expect(kanaToRomaji('きょう')).toBe('kyou');
    expect(kanaToRomaji('ラーメン')).toBe('raamen');
    expect(kanaToRomaji('食')).toBe('');
  });

  it('renders omitted ghost chips, the dialogue-relation banner and a neutral degraded notice', () => {
    const onRegenerate = vi.fn();
    const rich: SentenceExplanation = {
      ...EXPL,
      omitted: [{ text: '私は', role: '省略主语' }, { text: ' ' }],
      dialogueRelation: '湊在责备ことり，语气由随意转为强硬。',
      degraded: true,
    };
    render(<AiBreakdownPanel explanation={rich} focusCharIndex={0} onFocusChange={() => {}} onRegenerate={onRegenerate} t={t} />);
    const omitted = screen.getByTestId('breakdown-omitted');
    expect(omitted.querySelectorAll('.k-breakdown__ghost-chip')).toHaveLength(1);
    expect(omitted).toHaveTextContent('（省略：私は · 省略主语）');
    expect(screen.getByTestId('breakdown-dialogue-relation')).toHaveTextContent('句间关系与语体');
    expect(screen.getByTestId('breakdown-degraded')).toHaveTextContent('部分词块未通过原文对齐校验，已自动过滤');
    fireEvent.click(screen.getByTestId('breakdown-degraded-regenerate'));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('no omitted / relation / degraded blocks when absent', () => {
    render(<AiBreakdownPanel explanation={EXPL} focusCharIndex={0} onFocusChange={() => {}} t={t} />);
    expect(screen.queryByTestId('breakdown-omitted')).toBeNull();
    expect(screen.queryByTestId('breakdown-dialogue-relation')).toBeNull();
    expect(screen.queryByTestId('breakdown-degraded')).toBeNull();
  });

  it('🐢 replays at 0.75×; 🗣 跟读 plays, pauses 1.2× the slice with a countdown, then replays', () => {
    vi.useFakeTimers();
    const onReplayAudio = vi.fn();
    render(<AiBreakdownPanel explanation={EXPL} focusCharIndex={0} onFocusChange={() => {}} onReplayAudio={onReplayAudio} audioDurationMs={2000} t={t} />);
    fireEvent.click(screen.getByTestId('breakdown-replay-audio'));
    expect(onReplayAudio).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByTestId('breakdown-slow-audio'));
    expect(onReplayAudio).toHaveBeenLastCalledWith(0.75);
    onReplayAudio.mockClear();

    const shadow = screen.getByTestId('breakdown-shadow-audio');
    expect(shadow).toHaveTextContent('🗣 跟读');
    fireEvent.click(shadow);
    expect(onReplayAudio).toHaveBeenCalledTimes(1);
    expect(onReplayAudio).toHaveBeenLastCalledWith(1);
    expect(shadow).toHaveAttribute('data-phase', 'listen');
    act(() => void vi.advanceTimersByTime(2300)); // slice (2000) + padding
    expect(shadow).toHaveAttribute('data-phase', 'speak');
    expect(shadow).toHaveTextContent('🎙 请跟读… 3s'); // ceil(2.4 s)
    act(() => void vi.advanceTimersByTime(1000));
    expect(shadow).toHaveTextContent('🎙 请跟读… 2s');
    expect(onReplayAudio).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(1400)); // pause = 2400 ms total
    expect(onReplayAudio).toHaveBeenCalledTimes(2);
    expect(shadow).toHaveAttribute('data-phase', 'compare');
    act(() => void vi.advanceTimersByTime(2300));
    expect(shadow).toHaveAttribute('data-phase', 'idle');
    expect(shadow).toHaveTextContent('🗣 跟读');
  });

  it('opens at scrollTop 0 when the first chunk is focused', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.appendChild(scroller);
    const set = vi.fn();
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 0, set });
    render(<AiBreakdownPanel explanation={EXPL} focusCharIndex={0} onFocusChange={() => {}} onFollowUp={() => {}} t={t} />, { container: scroller });
    expect(set).toHaveBeenCalledWith(0);
    scroller.remove();
  });
});

describe('FollowUpThread', () => {
  beforeEach(resetStores);
  afterEach(() => vi.restoreAllMocks());
  const msg = (id: string, role: 'user' | 'model', text: string): FollowUpMessage => ({ id, role, text, createdAt: 0 }) as FollowUpMessage;

  it('never scrolls on mount or when a persisted thread is restored; follows only after the user asks', () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    const onAsk = vi.fn();
    const { rerender } = render(<FollowUpThread thread={[]} pending={false} onAsk={onAsk} t={t} />);
    expect(scroll).not.toHaveBeenCalled();
    // Thread restored asynchronously after open → still no scroll.
    rerender(<FollowUpThread thread={[msg('a', 'user', 'q'), msg('b', 'model', 'a')]} pending={false} onAsk={onAsk} t={t} />);
    expect(scroll).not.toHaveBeenCalled();
    // User asks → follow the answer.
    fireEvent.click(screen.getAllByRole('button').find((b) => b.classList.contains('k-chip')) ?? screen.getAllByRole('button')[0]!);
    expect(onAsk).toHaveBeenCalledTimes(1);
    rerender(<FollowUpThread thread={[msg('a', 'user', 'q'), msg('b', 'model', 'a'), msg('c', 'user', 'q2')]} pending streamingText="…" onAsk={onAsk} t={t} />);
    expect(scroll).toHaveBeenCalled();
    Element.prototype.scrollIntoView = original;
  });

  it('renderLight: bullets become a list and code inside bold has no raw markers', () => {
    const { container } = render(<div>{renderLight('要点：\n* **`てる`** 是 `ている` 的缩约\n- 第二点\n普通行')}</div>);
    const items = container.querySelectorAll('ul.k-md-list > li');
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector('strong > code')?.textContent).toBe('てる');
    expect(container.textContent).not.toMatch(/[`*]/);
    expect(items[1]?.textContent).toBe('第二点');
    expect(container.textContent).toContain('普通行');
  });
});
