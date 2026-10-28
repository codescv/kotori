import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformHost, SentenceExplanation, VocabEnrichment, VocabEntry } from '@kotori/core';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockHostOptions } from '../../host/mock-host';
import { explanationFor } from '../../host/mock/explanations';
import { createTranslator } from '../../i18n';
import * as tts from '../../lib/tts';
import { useBreakdownStore } from '../../stores/breakdown';
import { enrichmentCacheKey, LruCache, useDictStore } from '../../stores/dict';
import { glyphAt, resetStores } from '../../test/utils';
import { BreakdownPanel } from './AiBreakdownPanel';
import { ChunkCard } from './ChunkCard';
import { InstantDictPopup, useInstantLookup } from './InstantDictPopup';
import { formatRank, freqDictLabel, pickFrequencies, pitchLevels, splitMorae } from './PitchAccentBadge';
import { VocabList, vocabSpeechText } from './VocabList';

const t = createTranslator('zh-CN');
const BET = explanationFor('人生を賭けた勝負だって、わかってる。', 'zh-CN');
const KAKERU = explanationFor('命をかけても守りたいって、そう感じたんだ。', 'zh-CN');
const BAND = explanationFor('バンドの女子、ひとりで全部食べたって言ってた。', 'zh-CN');

function renderVocab(explanation: SentenceExplanation, options: MockHostOptions = {}) {
  const host = createMockPlatformHost({ latencyMs: 0, ...options });
  const utils = render(
    <HostProvider host={host}>
      <VocabList vocab={explanation.vocab} linkedIds={new Set()} onSelect={() => {}} t={t} />
    </HostProvider>,
  );
  return { host, ...utils };
}

const vocabByLemma = (e: SentenceExplanation, lemma: string) => {
  const v = e.vocab.find((x) => x.lemma === lemma);
  if (!v) throw new Error(`no vocab ${lemma}`);
  return v;
};

describe('PitchAccentBadge helpers', () => {
  it('splits morae: small kana merge, っ / ー stay separate', () => {
    expect(splitMorae('しょうがっこう')).toEqual(['しょ', 'う', 'が', 'っ', 'こ', 'う']);
    expect(splitMorae('ティーシャツ')).toEqual(['ティ', 'ー', 'シャ', 'ツ']);
    expect(splitMorae('かける')).toEqual(['か', 'け', 'る']);
  });

  it('pitch levels for 平板 / 頭高 / 中高 / 尾高 (+ particle)', () => {
    expect(pitchLevels(3, 0)).toEqual([false, true, true, true]);
    expect(pitchLevels(3, 1)).toEqual([true, false, false, false]);
    expect(pitchLevels(3, 2)).toEqual([false, true, false, false]);
    expect(pitchLevels(3, 3)).toEqual([false, true, true, false]);
  });

  it('frequency labels and per-dictionary pick (kana rank only when preferred)', () => {
    expect(freqDictLabel('JPDB v2.2')).toBe('JPDB');
    expect(formatRank(3851)).toBe('#3,851');
    const f = [
      { dictId: 'j', dictTitle: 'JPDB', value: 2055, displayValue: '2055' },
      { dictId: 'j', dictTitle: 'JPDB', value: 202, displayValue: '202㋕', kanaOnly: true },
    ];
    expect(pickFrequencies(f, false).map((x) => x.value)).toEqual([2055]);
    expect(pickFrequencies(f, true).map((x) => x.value)).toEqual([202]);
  });
});

describe('VocabList — three adaptive dictionary states', () => {
  beforeEach(resetStores);

  it('State 1 (matched): pitch SVG [2] + [JPDB #3,851] + 📖 dictionary senses for 賭ける', async () => {
    renderVocab(BET);
    const v = vocabByLemma(BET, '賭ける');
    const item = screen.getByTestId(`vocab-${v.id}`);
    const pitch = await within(item).findByTestId('vocab-pitch-badge');
    expect(item).toHaveAttribute('data-dict-status', 'matched');
    expect(pitch.textContent).toContain('[2]');
    expect(pitch.querySelector('svg')).not.toBeNull();
    expect(pitch.querySelectorAll('circle.is-high')).toHaveLength(1); // か(L) け(H) る(L)
    expect(within(pitch).getByTestId('pitch-downstep')).toBeInTheDocument();
    expect(pitch.getAttribute('title')).toContain('Kanjium');
    // R1: only the exact (賭ける, かける) rank — never 掛ける's #202㋕.
    const freq = within(item).getAllByTestId('vocab-freq-badge');
    expect(freq.map((f) => f.textContent)).toEqual(['[JPDB #3,851]']);
    const senses = within(item).getByTestId('vocab-dict-senses');
    expect(senses.textContent).toContain('📖 词典释义');
    expect(senses.textContent).toContain('赌博，打赌，押注');
    expect(senses.textContent).toContain('命を賭けて戦う');
    expect(item.textContent).toContain('🎯 语境义');
    expect(item.textContent).toContain('💡 语感');
    expect(item.textContent).toContain('孤注一掷');
  });

  it('kanji lemma 分かる falls back to the kana headword わかる (Orthography Guard)', async () => {
    renderVocab(BET);
    const v = vocabByLemma(BET, '分かる');
    const item = screen.getByTestId(`vocab-${v.id}`);
    expect((await within(item).findByTestId('vocab-dict-senses')).textContent).toContain('明白，懂');
    expect(within(item).getByTestId('vocab-freq-badge').textContent).toBe('[JPDB #190]');
    expect(within(item).getByTestId('vocab-pitch-badge').textContent).toContain('[2]');
  });

  it('State 2 (uncertain): kana かける shows the kana rank and collapsible homograph candidates', async () => {
    renderVocab(KAKERU);
    const v = vocabByLemma(KAKERU, 'かける');
    const item = screen.getByTestId(`vocab-${v.id}`);
    const toggle = await within(item).findByTestId('vocab-uncertain-candidates');
    expect(item).toHaveAttribute('data-dict-status', 'uncertain');
    expect(toggle.textContent).toContain('📖 词典同音候选 (4)');
    expect(toggle.textContent).toContain('賭ける[2](#3,851)');
    expect(toggle.textContent).toContain('欠ける[0]');
    expect(within(item).getByTestId('vocab-freq-badge').textContent).toBe('[JPDB かける(假名表记) #202]');
    expect(within(item).queryByTestId('vocab-pitch-badge')).toBeNull();
    expect(within(item).queryByTestId('vocab-dict-senses')).toBeNull();
    expect(within(item).queryByTestId('vocab-candidate-list')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = within(item).getByTestId('vocab-candidate-list');
    for (const hw of ['賭ける', '掛ける', '駆ける', '欠ける']) expect(within(list).getByTestId(`vocab-candidate-${hw}`)).toBeInTheDocument();
    const kake = within(list).getByTestId('vocab-candidate-掛ける');
    expect(within(kake).getByTestId('candidate-pitch-badge').textContent).toContain('[2]');
    expect(within(kake).getByTestId('candidate-freq-badge').textContent).toBe('[JPDB #2,055]');
    expect(kake.textContent).toContain('挂，悬挂');
    expect(within(list).getByTestId('vocab-candidate-欠ける').textContent).toContain('[0]');
    fireEvent.click(toggle);
    expect(within(item).queryByTestId('vocab-candidate-list')).toBeNull();
  });

  it('State 3 (zero dictionaries): clean AI-only card, no badges, no enrichment call', async () => {
    const { host } = renderVocab(BET, { dictionaries: 'empty' });
    await waitFor(() => expect(useDictStore.getState().loaded).toBe(true));
    await act(async () => {});
    const v = vocabByLemma(BET, '賭ける');
    const item = screen.getByTestId(`vocab-${v.id}`);
    expect(item).not.toHaveAttribute('data-dict-status');
    expect(within(item).queryByTestId('vocab-pitch-badge')).toBeNull();
    expect(within(item).queryByTestId('vocab-freq-badge')).toBeNull();
    expect(within(item).queryByTestId('vocab-dict-senses')).toBeNull();
    expect(item.textContent).not.toContain('🎯');
    expect(item.textContent).toContain('赌上，押上');
    expect(item.textContent).toContain('活用');
    expect(host.calls.get('dict.enrichVocab') ?? 0).toBe(0);
  });

  it('State 3 without any dictionary host (legacy host): AI-only card', () => {
    renderVocab(BET, { dictionaries: 'absent' });
    const v = vocabByLemma(BET, '賭ける');
    const item = screen.getByTestId(`vocab-${v.id}`);
    expect(within(item).queryByTestId('vocab-pitch-badge')).toBeNull();
    expect(item.textContent).toContain('赌上，押上');
  });

  it('State 3 (empty but with meta): pitch / frequency still render without placeholders', () => {
    const v = vocabByLemma(BET, '賭ける');
    const enrichment: Record<string, VocabEnrichment> = {
      [v.id]: {
        status: 'empty',
        pitches: [{ reading: 'かける', position: 2, sources: ['Kanjium'] }],
        frequencies: [{ dictId: 'jpdb', dictTitle: 'JPDB v2.2', value: 3851, displayValue: '3851' }],
        senseGroups: [],
      },
    };
    render(<VocabList vocab={[v]} linkedIds={new Set()} onSelect={() => {}} t={t} enrichment={enrichment} />);
    expect(screen.getByTestId('vocab-pitch-badge').textContent).toContain('[2]');
    expect(screen.getByTestId('vocab-freq-badge').textContent).toBe('[JPDB #3,851]');
    expect(screen.queryByTestId('vocab-dict-senses')).toBeNull();
    expect(screen.queryByTestId('vocab-uncertain-candidates')).toBeNull();
  });

  it('shows up to 3 senses with an expand toggle', () => {
    const v = vocabByLemma(BET, '賭ける');
    const senses = ['一', '二', '三', '四', '五'].map((g) => ({ gloss: `义项${g}` }));
    const enrichment: Record<string, VocabEnrichment> = {
      [v.id]: { status: 'matched', pitches: [], frequencies: [], senseGroups: [{ dictId: 'd', dictTitle: 'D', expression: '賭ける', reading: 'かける', defTags: '', senses, matchedSenseIdx: 1 }] },
    };
    render(<VocabList vocab={[v]} linkedIds={new Set()} onSelect={() => {}} t={t} enrichment={enrichment} />);
    const box = screen.getByTestId('vocab-dict-senses');
    expect(box.querySelectorAll('li')).toHaveLength(3);
    expect(box.querySelector('li[data-matched]')?.textContent).toContain('义项二');
    fireEvent.click(screen.getByTestId('vocab-dict-senses-toggle'));
    expect(box.querySelectorAll('li')).toHaveLength(5);
    expect(screen.getByTestId('vocab-dict-senses-toggle').textContent).toBe('收起');
  });

  it('re-enriches when the dictionary set changes (dictSetRevision) and never mutates the explanation', async () => {
    const snapshot = JSON.stringify(BET);
    const { host } = renderVocab(BET);
    const v = vocabByLemma(BET, '賭ける');
    const item = screen.getByTestId(`vocab-${v.id}`);
    await within(item).findByTestId('vocab-pitch-badge');
    const rev = useDictStore.getState().dictSetRevision;
    await act(async () => {
      await useDictStore.getState().toggleEnabled(host as PlatformHost, 'kanjium-pitch', false);
    });
    expect(useDictStore.getState().dictSetRevision).toBe(rev + 1);
    await waitFor(() => expect(within(item).queryByTestId('vocab-pitch-badge')).toBeNull());
    expect(within(item).getByTestId('vocab-freq-badge').textContent).toBe('[JPDB #3,851]');
    expect(JSON.stringify(BET)).toBe(snapshot);
    expect(BET.vocab.some((x) => 'pitches' in x || 'senseGroups' in x)).toBe(false);
  });

  it('render-time LRU cache: a second render of the same vocab does not call the host again', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const ui = (
      <HostProvider host={host}>
        <VocabList vocab={BAND.vocab} linkedIds={new Set()} onSelect={() => {}} t={t} />
      </HostProvider>
    );
    const first = render(ui);
    await screen.findAllByTestId('vocab-pitch-badge');
    const calls = host.calls.get('dict.enrichVocab');
    first.unmount();
    render(ui);
    expect(screen.getAllByTestId('vocab-pitch-badge').length).toBeGreaterThan(0); // synchronous cache hit
    expect(host.calls.get('dict.enrichVocab')).toBe(calls);
    const key = enrichmentCacheKey(useDictStore.getState().dictSetRevision, BAND.vocab[0]!);
    expect(key).toContain(':バンド:');
  });

  it('LruCache evicts the least recently used entry', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
  });
});

function InstantHarness({ sentence, index }: { readonly sentence: string; readonly index: number }) {
  const [i, setI] = useState(index);
  const state = useInstantLookup(sentence, i);
  return (
    <>
      <button type="button" data-testid="move" onClick={() => setI(sentence.indexOf('言'))} />
      <InstantDictPopup state={state} collapsible />
    </>
  );
}

describe('InstantDictPopup — P2 click-to-lookup', () => {
  beforeEach(resetStores);

  it('shows the longest deinflected prefix match with pitch, frequency and senses', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const sentence = BAND.sentence;
    render(
      <HostProvider host={host}>
        <InstantHarness sentence={sentence} index={sentence.indexOf('食')} />
      </HostProvider>,
    );
    const popup = await screen.findByTestId('instant-dict-popup');
    await waitFor(() => expect(within(popup).getByTestId('instant-dict-headline').textContent).toContain('食べた ← 食べる'));
    expect(within(popup).getByTestId('instant-dict-chain')).toBeInTheDocument();
    expect(within(popup).getByTestId('instant-pitch-badge').textContent).toContain('[2]');
    expect(within(popup).getByTestId('instant-freq-badge').textContent).toBe('[JPDB #310]');
    expect(within(popup).getByTestId('instant-dict-senses').textContent).toContain('吃，食用');
    expect(host.calls.get('dict.lookupPrefix')).toBe(1);

    fireEvent.click(screen.getByTestId('move'));
    await waitFor(() => expect(within(screen.getByTestId('instant-dict-popup')).getByTestId('instant-dict-headline').textContent).toContain('言う'));

    fireEvent.click(screen.getByTestId('instant-dict-collapse'));
    expect(screen.queryByTestId('instant-dict-senses')).toBeNull();
    fireEvent.click(screen.getByTestId('instant-dict-dismiss'));
    expect(screen.queryByTestId('instant-dict-popup')).toBeNull();
  });

  it('BreakdownPanel looks up the tapped character in parallel with the AI call', async () => {
    const host = createMockPlatformHost({ latencyMs: 5 });
    const sentence = BAND.sentence;
    render(
      <HostProvider host={host}>
        <BreakdownPanel />
      </HostProvider>,
    );
    let opening: Promise<void> | undefined;
    act(() => {
      opening = useBreakdownStore.getState().open(host, { sentence, source: { kind: 'manual' }, focusCharIndex: sentence.indexOf('食') });
    });
    // Visible while the AI breakdown is still loading.
    expect(screen.getByTestId('breakdown-loading')).toBeInTheDocument();
    const popup = await screen.findByTestId('instant-dict-popup');
    await waitFor(() => expect(within(popup).getByTestId('instant-dict-headline').textContent).toContain('食べる'));
    await act(async () => {
      await opening;
    });
    // AI ready: still shown, now collapsible / dismissible.
    expect(await screen.findByTestId('ai-breakdown-panel')).toBeInTheDocument();
    expect(screen.getByTestId('instant-dict-popup')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('instant-dict-dismiss'));
    expect(screen.queryByTestId('instant-dict-popup')).toBeNull();
    // Tapping another word in the sticky sentence header looks it up.
    fireEvent.click(glyphAt(screen.getByTestId('breakdown-sentence'), sentence.indexOf('バ')));
    await waitFor(() => expect(within(screen.getByTestId('instant-dict-popup')).getByTestId('instant-dict-headline').textContent).toContain('バンド'));
  });

  it('snaps mid-word taps ("ハ" in "ライブハウスで歌う", "子" in "女子", "べ" in "食べた") to the word start for lookup and highlights the full word', async () => {
    const host = createMockPlatformHost({ latencyMs: 5 });
    const sentence = 'ライブハウスで歌う';
    render(
      <HostProvider host={host}>
        <BreakdownPanel />
      </HostProvider>,
    );
    let opening: Promise<void> | undefined;
    act(() => {
      // Tap middle kana 'ハ' (index 3) inside "ライブハウス" [0, 6).
      opening = useBreakdownStore.getState().open(host, { sentence, source: { kind: 'manual' }, focusCharIndex: 3 });
    });

    const loadingBox = screen.getByTestId('breakdown-loading');
    for (let i = 0; i < 6; i++) {
      expect(glyphAt(loadingBox, i)).toHaveClass('is-focus');
    }
    expect(glyphAt(loadingBox, 0)).toHaveClass('is-focus-start');
    expect(glyphAt(loadingBox, 5)).toHaveClass('is-focus-end');
    expect(glyphAt(loadingBox, 6)).not.toHaveClass('is-focus');

    const popup = await screen.findByTestId('instant-dict-popup');
    await waitFor(() => expect(within(popup).getByTestId('instant-dict-headline').textContent).toContain('ライブハウス'));
    expect(within(popup).getByTestId('instant-dict-senses').textContent).toContain('Livehouse');

    await act(async () => {
      await opening;
    });
    const header = screen.getByTestId('breakdown-sentence');
    for (let i = 0; i < 6; i++) {
      expect(glyphAt(header, i)).toHaveClass('is-focus');
    }
    expect(glyphAt(header, 0)).toHaveClass('is-focus-start');
    expect(glyphAt(header, 5)).toHaveClass('is-focus-end');
    expect(glyphAt(header, 6)).not.toHaveClass('is-focus');

    // Mid-word kanji ('子' in "女子") and okurigana ('べ' in "食べた") also snap to word start in InstantDictPopup.
    const bandSentence = BAND.sentence;
    act(() => {
      opening = useBreakdownStore.getState().open(host, {
        sentence: bandSentence,
        source: { kind: 'manual' },
        focusCharIndex: bandSentence.indexOf('子'),
      });
    });
    await waitFor(() => expect(within(screen.getByTestId('instant-dict-popup')).getByTestId('instant-dict-headline').textContent).toContain('女子'));
    await act(async () => {
      await opening;
    });
    fireEvent.click(glyphAt(screen.getByTestId('breakdown-sentence'), bandSentence.indexOf('べ')));
    await waitFor(() =>
      expect(within(screen.getByTestId('instant-dict-popup')).getByTestId('instant-dict-headline').textContent).toContain('食べた ← 食べる'),
    );
  });
});

describe('Vocabulary TTS — disambiguated kana reading & touch propagation', () => {
  beforeEach(resetStores);
  afterEach(() => vi.restoreAllMocks());

  it('vocabSpeechText resolves kana reading across all 4 priorities instead of bare kanji', () => {
    const base: VocabEntry = {
      id: 'v0',
      charSpan: [0, 2],
      alignment: 'exact',
      surface: '女子',
      lemma: '女子',
      lemmaReading: 'じょし',
      lemmaRuby: [{ base: '女子', ruby: 'じょし', charSpan: [0, 2] }],
      partOfSpeech: 'noun',
      meaning: '女生',
    };
    // Priority 1: non-kanji lemmaReading
    expect(vocabSpeechText(base)).toBe('じょし');

    // Priority 2: reconstructed kana from lemma + lemmaRuby when lemmaReading is empty
    const rubyOnly: VocabEntry = {
      ...base,
      lemma: '賭ける',
      surface: '賭けた',
      lemmaReading: '',
      lemmaRuby: [
        { base: '賭', ruby: 'か', charSpan: [0, 1] },
        { base: 'ける', charSpan: [1, 3] },
      ],
    };
    expect(vocabSpeechText(rubyOnly)).toBe('かける');

    // Priority 3: dictionary enrichment reading when neither lemmaReading nor ruby furigana exist
    const noReading: VocabEntry = {
      ...base,
      lemma: '食べる',
      surface: '食べた',
      lemmaReading: '',
      lemmaRuby: [{ base: '食べる', charSpan: [0, 3] }],
    };
    const enriched: VocabEnrichment = {
      status: 'matched',
      pitches: [{ reading: 'たべる', position: 2, sources: ['Kanjium'] }],
      frequencies: [],
      senseGroups: [],
    };
    expect(vocabSpeechText(noReading, enriched)).toBe('たべる');

    // Priority 4: fallback to lemma / surface
    expect(vocabSpeechText({ ...noReading, lemmaRuby: [] })).toBe('食べる');
  });

  it('clicking vocab-tts-* speaks kana reading ("じょし", "かける") and does not select the parent card', async () => {
    const speakSpy = vi.spyOn(tts, 'speakJapanese').mockReturnValue(true);
    const onSelect = vi.fn();
    const host = createMockPlatformHost({ latencyMs: 0 });
    const first = render(
      <HostProvider host={host}>
        <VocabList vocab={BAND.vocab} linkedIds={new Set()} onSelect={onSelect} t={t} />
      </HostProvider>,
    );
    const joshi = vocabByLemma(BAND, '女子');
    fireEvent.pointerDown(screen.getByTestId(`vocab-tts-${joshi.id}`));
    fireEvent.touchStart(screen.getByTestId(`vocab-tts-${joshi.id}`));
    fireEvent.click(screen.getByTestId(`vocab-tts-${joshi.id}`));
    expect(speakSpy).toHaveBeenCalledWith('じょし');
    expect(onSelect).not.toHaveBeenCalled();
    first.unmount();

    speakSpy.mockClear();
    renderVocab(KAKERU);
    const kakeru = vocabByLemma(KAKERU, 'かける');
    const item = screen.getByTestId(`vocab-${kakeru.id}`);
    const toggle = await within(item).findByTestId('vocab-uncertain-candidates');
    fireEvent.click(screen.getByTestId(`vocab-tts-${kakeru.id}`));
    expect(speakSpy).toHaveBeenCalledWith('かける');

    // Candidate TTS inside UncertainCandidates
    speakSpy.mockClear();
    fireEvent.click(toggle);
    fireEvent.click(within(item).getByTestId('vocab-candidate-tts-0'));
    expect(speakSpy).toHaveBeenCalledWith('かける');
  });

  it('InstantDictPopup instant-dict-tts and ChunkCard chunk-vocab-tts-* speak kana readings', async () => {
    const speakSpy = vi.spyOn(tts, 'speakJapanese').mockReturnValue(true);
    const host = createMockPlatformHost({ latencyMs: 0 });
    const sentence = BAND.sentence;
    const popupView = render(
      <HostProvider host={host}>
        <InstantHarness sentence={sentence} index={sentence.indexOf('食')} />
      </HostProvider>,
    );
    const popup = await screen.findByTestId('instant-dict-popup');
    await waitFor(() => expect(within(popup).getByTestId('instant-dict-headline').textContent).toContain('食べる'));
    fireEvent.click(within(popup).getByTestId('instant-dict-tts'));
    expect(speakSpy).toHaveBeenCalledWith('たべる');
    popupView.unmount();

    speakSpy.mockClear();
    const onSelectChunk = vi.fn();
    const joshi = vocabByLemma(BAND, '女子');
    const joshiChunk = BAND.chunks.find((c) => c.vocabIds.includes(joshi.id))!;
    const chunkVocab = BAND.vocab.filter((v) => joshiChunk.vocabIds.includes(v.id));
    render(<ChunkCard chunk={joshiChunk} index={1} active vocab={chunkVocab} onSelect={onSelectChunk} t={t} />);
    fireEvent.click(screen.getByTestId(`chunk-vocab-tts-${joshi.id}`));
    expect(speakSpy).toHaveBeenCalledWith('じょし');
    expect(onSelectChunk).not.toHaveBeenCalled();
  });
});
