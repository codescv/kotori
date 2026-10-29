import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpMessage, SentenceExplanation } from '@kotori/core';
import { DEFAULT_SETTINGS } from '../../app/default-settings';
import { CANNED_SPECS, explanationFor } from '../../host/mock/explanations';
import { createTranslator } from '../../i18n';
import { partitionVocabByChunk } from '../../lib/explanation';
import { useSettingsStore } from '../../stores/settings';
import { glyphAt, resetStores } from '../../test/utils';
import { AiBreakdownPanel } from './AiBreakdownPanel';
import { FollowUpThread, renderLight } from './FollowUpThread';
import { kanaToRomaji } from './romaji';
import { deriveSelection } from './useBreakdownSelection';

const t = createTranslator('zh-CN');
const EXPL = explanationFor('食べてんじゃねぇよ！', 'zh-CN');

function Harness({
  explanation,
  initial,
  onFollowUp,
}: {
  readonly explanation: SentenceExplanation;
  readonly initial?: number;
  readonly onFollowUp?: (q: string) => void;
}) {
  const [focus, setFocus] = useState<number | undefined>(initial);
  return (
    <>
      <output data-testid="focus">{focus ?? ''}</output>
      <AiBreakdownPanel
        explanation={explanation}
        focusCharIndex={focus}
        onFocusChange={setFocus}
        {...(onFollowUp ? { onFollowUp } : {})}
        t={t}
      />
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

  it('unified 0-tab flow: renders inline vocab & grammar on active chunk, clickable lemma chips on inactive chunks, and 1-tap chip expansion', () => {
    render(<Harness explanation={EXPL} initial={3} />);
    // Zero tabs in unified flow.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    // Active chunk (c1) expands compact VocabItem and displays inline grammar.
    const activeVocab = screen.getByTestId('chunk-vocab-v1');
    expect(activeVocab).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('chunk-grammar-g0')).toHaveTextContent('📐 〜ているのではない · N3');
    expect(screen.queryByTestId('chunk-vocab-chip-v1')).toBeNull();

    // Inactive chunks (c0, c2) collapse vocab to clickable lemma chips.
    expect(screen.queryByTestId('chunk-vocab-v0')).toBeNull();
    const chip0 = screen.getByTestId('chunk-vocab-chip-v0');
    expect(chip0).toHaveTextContent('食べる');
    expect(screen.getByTestId('chunk-vocab-chip-v2')).toHaveTextContent('よ');

    // Clicking an inactive chunk's lemma chip focuses that word and expands its VocabItem in 1 tap.
    fireEvent.click(chip0);
    expect(screen.getByTestId('focus').textContent).toBe('0');
    expect(screen.getByTestId('chunk-c0')).toHaveAttribute('aria-current', 'true');
    const expandedV0 = screen.getByTestId('chunk-vocab-v0');
    expect(expandedV0).toHaveAttribute('aria-current', 'true');
    // Unreliable model pitch accent is intentionally not rendered without local dictionary enrichment.
    expect(expandedV0.textContent).not.toContain('②');
    expect(expandedV0.querySelector('.k-vocab__pitch')).toBeNull();
    // Previously active c1 collapses back to a lemma chip.
    expect(screen.getByTestId('chunk-vocab-chip-v1')).toBeInTheDocument();
  });

  it('renders chunk.grammarPattern chip and deduplicates against legacy grammar[]', () => {
    const withPattern: SentenceExplanation = {
      ...EXPL,
      grammar: [{ id: 'g0', pattern: '〜ているのではない', chunkIds: ['c1'], explanation: '否定说明语气', jlpt: 'N3' }],
      chunks: EXPL.chunks.map((c, idx) =>
        idx === 0
          ? { ...c, grammarPattern: '〜てみる' }
          : idx === 1
            ? { ...c, grammarPattern: '~ているのではない' }
            : c,
      ),
    };
    render(<Harness explanation={withPattern} />);
    expect(screen.getByTestId('chunk-grammar-pattern-c0')).toHaveTextContent('📐 〜てみる');
    // c1's grammarPattern matches legacy g0.pattern (modulo tilde variant) -> deduplicated.
    expect(screen.getByTestId('chunk-grammar-g0')).toHaveTextContent('📐 〜ているのではない · N3');
    expect(screen.queryByTestId('chunk-grammar-pattern-c1')).toBeNull();
  });

  it('partitionVocabByChunk guarantees 0 dropped vocab across all 4 tiers and renders orphans in breakdown-orphan-vocab', () => {
    for (const spec of CANNED_SPECS) {
      const expl = explanationFor(spec.sentence, 'zh-CN');
      const { byChunk, orphans } = partitionVocabByChunk(expl);
      const seen = [...Array.from(byChunk.values()).flat(), ...orphans].map((v) => v.id);
      expect(new Set(seen).size).toBe(expl.vocab.length);
      expect(orphans).toHaveLength(0);
    }

    // Synthetic explanation exercising Step 2 (containment), Step 2b (partial overlap), and Step 3 (orphan vocab + unlinked grammar).
    const baseVocab = EXPL.vocab[0]!;
    const synthetic: SentenceExplanation = {
      ...EXPL,
      chunks: EXPL.chunks.map((c) => ({ ...c, vocabIds: [] })), // clear explicit vocabIds to exercise fallbacks
      vocab: [
        { ...baseVocab, id: 'v_contain', surface: '食べ', lemma: '食べる', charSpan: [0, 2] }, // contained in c0 [0,2)
        { ...baseVocab, id: 'v_straddle', surface: '食べてん', lemma: '食べてん', charSpan: [1, 4] }, // straddles c0 [0,2) & c1 [2,8) -> c0
        { ...baseVocab, id: 'v_orphan', surface: '慣用句', lemma: '慣用句', meaning: '未对齐惯用语', charSpan: [0, 0], alignment: 'unaligned' },
      ],
      grammar: [{ id: 'g_orphan', pattern: '〜っけ', chunkIds: [], explanation: '回想确认终助词' }],
    };
    const { byChunk, orphans } = partitionVocabByChunk(synthetic);
    expect(byChunk.get('c0')?.map((v) => v.id)).toEqual(['v_contain', 'v_straddle']);
    expect(orphans.map((v) => v.id)).toEqual(['v_orphan']);

    render(<Harness explanation={synthetic} initial={0} />);
    expect(screen.getByTestId('chunk-vocab-v_contain')).toBeInTheDocument();
    expect(screen.getByTestId('chunk-vocab-v_straddle')).toBeInTheDocument();
    const orphanSection = screen.getByTestId('breakdown-orphan-vocab');
    expect(orphanSection).toHaveTextContent('未对齐惯用语');
    expect(orphanSection).toHaveTextContent('📐 〜っけ');
  });

  it('horizontal chunkSwipe switches active chunks while respecting -1 initial state, viewport edges, and exclusions', () => {
    render(<Harness explanation={EXPL} onFollowUp={() => {}} />);
    const panel = screen.getByTestId('ai-breakdown-panel');
    expect(panel).toHaveAttribute('data-no-tab-swipe');

    const swipe = (target: Element, x0: number, y0: number, x1: number, y1: number) => {
      fireEvent.touchStart(target, { touches: [{ clientX: x0, clientY: y0 }] });
      fireEvent.touchEnd(target, { changedTouches: [{ clientX: x1, clientY: y1 }] });
    };

    // From unfocused (-1), swipe right -> last chunk (c2).
    swipe(panel, 180, 240, 250, 244);
    expect(screen.getByTestId('chunk-c2')).toHaveAttribute('aria-current', 'true');

    // Swipe right -> previous chunk (c1), then (c0), then clamped at c0.
    swipe(panel, 180, 240, 250, 242);
    expect(screen.getByTestId('chunk-c1')).toHaveAttribute('aria-current', 'true');
    swipe(panel, 180, 240, 250, 242);
    expect(screen.getByTestId('chunk-c0')).toHaveAttribute('aria-current', 'true');
    swipe(panel, 180, 240, 250, 242);
    expect(screen.getByTestId('chunk-c0')).toHaveAttribute('aria-current', 'true');

    // Swipe left -> next chunk (c1).
    swipe(panel, 240, 240, 160, 244);
    expect(screen.getByTestId('chunk-c1')).toHaveAttribute('aria-current', 'true');

    // Excluded zones: viewport left edge (<= 24px), button, and vertical scroll (|dy| >= 36) do not switch chunks.
    swipe(panel, 12, 240, 100, 240);
    expect(screen.getByTestId('chunk-c1')).toHaveAttribute('aria-current', 'true');
    const ttsBtn = screen.getByTestId('breakdown-tts-sentence');
    swipe(ttsBtn, 200, 240, 120, 240);
    expect(screen.getByTestId('chunk-c1')).toHaveAttribute('aria-current', 'true');
    swipe(panel, 220, 240, 140, 290);
    expect(screen.getByTestId('chunk-c1')).toHaveAttribute('aria-current', 'true');
  });

  it('deriveSelection: no focus → nothing highlighted', () => {
    expect(deriveSelection(EXPL, undefined).activeChunk).toBeUndefined();
    expect(deriveSelection(EXPL, undefined).focusWordSpan).toBeUndefined();
    expect(deriveSelection(EXPL, undefined).vocabAtFocus).toBeUndefined();
    expect(deriveSelection(EXPL, 0).activeChunk?.id).toBe('c0');
    expect(deriveSelection(EXPL, 1).focusWordSpan).toEqual([0, 2]);
    expect(deriveSelection(EXPL, 1).vocabAtFocus?.id).toBe('v0');
    expect([...deriveSelection(EXPL, 2).linkedVocabIds]).toEqual(['v1']);
  });

  it('clicking a middle character of a word highlights all glyphs of that word in the sticky header', () => {
    const bandExpl = explanationFor('バンドの女子、ひとりで全部食べたって言ってた。', 'zh-CN');
    const { unmount } = render(<Harness explanation={bandExpl} />);
    // Click 'ン' (index 1) inside 'バンド' [0, 3) → highlights 'バ', 'ン', 'ド', not 'の' (index 3).
    fireEvent.click(glyphAt(sentence(), 1));
    expect(glyphAt(sentence(), 0)).toHaveClass('is-focus', 'is-focus-start');
    expect(glyphAt(sentence(), 1)).toHaveClass('is-focus');
    expect(glyphAt(sentence(), 2)).toHaveClass('is-focus', 'is-focus-end');
    expect(glyphAt(sentence(), 3)).not.toHaveClass('is-focus');

    // Click '子' (index 5) inside '女子' [4, 6) → highlights both '女' and '子'.
    fireEvent.click(glyphAt(sentence(), 5));
    expect(glyphAt(sentence(), 3)).not.toHaveClass('is-focus');
    expect(glyphAt(sentence(), 4)).toHaveClass('is-focus', 'is-focus-start');
    expect(glyphAt(sentence(), 5)).toHaveClass('is-focus', 'is-focus-end');
    expect(glyphAt(sentence(), 6)).not.toHaveClass('is-focus');

    // Click 'べ' (index 14) inside '食べた' [13, 16) → highlights '食', 'べ', 'た'.
    fireEvent.click(glyphAt(sentence(), 14));
    expect(glyphAt(sentence(), 13)).toHaveClass('is-focus', 'is-focus-start');
    expect(glyphAt(sentence(), 14)).toHaveClass('is-focus');
    expect(glyphAt(sentence(), 15)).toHaveClass('is-focus', 'is-focus-end');
    expect(glyphAt(sentence(), 16)).not.toHaveClass('is-focus');
    unmount();

    // Katakana compound ("ライブハウス") stays highlighted as one full 6-kana word even if AI vocab split it.
    const livehouseExpl = explanationFor('下北沢のライブハウスで演奏した。', 'zh-CN');
    render(<Harness explanation={livehouseExpl} />);
    fireEvent.click(glyphAt(sentence(), 7)); // 'ハ' inside 'ライブハウス' [4, 10)
    expect(glyphAt(sentence(), 3)).not.toHaveClass('is-focus'); // 'の'
    for (let i = 4; i < 10; i++) {
      expect(glyphAt(sentence(), i)).toHaveClass('is-focus');
    }
    expect(glyphAt(sentence(), 4)).toHaveClass('is-focus-start');
    expect(glyphAt(sentence(), 9)).toHaveClass('is-focus-end');
    expect(glyphAt(sentence(), 10)).not.toHaveClass('is-focus'); // 'で'
  });

  it('renders manga bubble crop preview, cultural note card, audio slice replay, and conditional TTS / cache meta cleanup', () => {
    let replayed = false;
    const withCultural: SentenceExplanation = {
      ...EXPL,
      fromCache: true,
      culturalNote: '下北沢（しもきたざわ）是东京著名的独立摇滚与 Livehouse 圣地。',
    };
    const { container, rerender } = render(
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
    // Cached tag is dropped from the meta row even when explanation.fromCache is true.
    expect(container.querySelector('.k-tag--muted')).toBeNull();
    expect(screen.queryByText(t('breakdown.fromCache'))).toBeNull();
    // Subtitle audio available: slow audio uses "🐢 慢放" and TTS button is hidden.
    expect(screen.getByTestId('breakdown-slow-audio')).toHaveTextContent('🐢 慢放');
    expect(screen.queryByTestId('breakdown-tts-sentence')).toBeNull();
    fireEvent.click(screen.getByTestId('breakdown-replay-audio'));
    expect(replayed).toBe(true);

    // Manga / manual sentence without source audio: "🗣️ 朗读" TTS pill is rendered.
    rerender(<AiBreakdownPanel explanation={withCultural} focusCharIndex={0} onFocusChange={() => {}} t={t} />);
    expect(screen.getByTestId('breakdown-tts-sentence')).toHaveTextContent('🗣️ 朗读');
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
