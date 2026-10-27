import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SentenceExplanation } from '@kotori/core';
import { explanationFor } from '../../host/mock/explanations';
import { createTranslator } from '../../i18n';
import { glyphAt, resetStores } from '../../test/utils';
import { AiBreakdownPanel } from './AiBreakdownPanel';
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
    // pitch accent mark ② for 食べる
    expect(screen.getByTestId('vocab-v0').textContent).toContain('②');
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
