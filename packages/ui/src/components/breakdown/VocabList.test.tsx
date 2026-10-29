import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { AiBreakdownPanel, BreakdownPanel } from './AiBreakdownPanel';
import { ChunkCard } from './ChunkCard';
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

describe('Unified inline <VocabItem compact /> in ChunkCard & AiBreakdownPanel', () => {
  beforeEach(resetStores);
  afterEach(() => vi.restoreAllMocks());

  it('enriches all sentence vocab in 1 batch RPC, renders compact pitch/freq/senses inside ChunkCard, and removes InstantDictPopup', async () => {
    const host = createMockPlatformHost({ latencyMs: 5 });
    const sentence = BAND.sentence;
    render(
      <HostProvider host={host}>
        <BreakdownPanel />
      </HostProvider>,
    );
    let opening: Promise<void> | undefined;
    act(() => {
      opening = useBreakdownStore.getState().open(host, {
        sentence,
        source: { kind: 'manual' },
        focusCharIndex: sentence.indexOf('食'),
      });
    });

    // Skeleton highlights without InstantDictPopup.
    expect(screen.getByTestId('breakdown-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('instant-dict-popup')).toBeNull();
    expect(host.calls.get('dict.lookupPrefix') ?? 0).toBe(0);

    await act(async () => {
      await opening;
    });
    expect(await screen.findByTestId('ai-breakdown-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('instant-dict-popup')).toBeNull();

    const taberu = vocabByLemma(BAND, '食べる');
    const compactCard = screen.getByTestId(`chunk-vocab-${taberu.id}`);
    expect(compactCard).toHaveClass('k-vocab', 'k-vocab--compact', 'is-linked');
    expect(compactCard).toHaveAttribute('aria-current', 'true');

    const pitch = await within(compactCard).findByTestId('vocab-pitch-badge');
    expect(pitch.textContent).toContain('[2]');
    expect(within(compactCard).getByTestId('vocab-freq-badge').textContent).toBe('[JPDB #310]');
    expect(within(compactCard).getByTestId(`chunk-vocab-tts-${taberu.id}`)).toBeInTheDocument();
    expect(within(compactCard).getByTestId(`chunk-vocab-meaning-${taberu.id}`).textContent).toContain('食べた ← ');

    const senses = within(compactCard).getByTestId('vocab-dict-senses');
    expect(senses.textContent).toContain('吃，食用');
    // Compact mode: showLabel={false}, limit={2}, no POS chip, no 🎯 语境义 prefix, no notes.
    expect(senses.textContent).not.toContain('📖 词典释义');
    expect(senses.querySelectorAll('li').length).toBeLessThanOrEqual(2);
    expect(compactCard.querySelector('.k-pos')).toBeNull();
    expect(compactCard.textContent).not.toContain('🎯 语境义');
    expect(compactCard.textContent).not.toContain('💡 语感');

    // Only 1 batch enrichVocab RPC for the whole sentence; switching chunks or opening 词汇 tab triggers 0 extra RPCs.
    expect(host.calls.get('dict.enrichVocab')).toBe(1);
    fireEvent.click(screen.getByTestId(`chunk-${BAND.chunks[0]!.id}`));
    const bando = vocabByLemma(BAND, 'バンド');
    expect(within(screen.getByTestId(`chunk-vocab-${bando.id}`)).getByTestId('vocab-pitch-badge')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /词汇/ }));
    expect(within(screen.getByTestId(`vocab-${taberu.id}`)).getByTestId('vocab-pitch-badge')).toBeInTheDocument();
    expect(host.calls.get('dict.enrichVocab')).toBe(1);
  });

  it('highlights full katakana word in BreakdownSkeleton and preserves click focus inside ChunkCard without bubbling or reordering', async () => {
    const host = createMockPlatformHost({ latencyMs: 5 });
    render(
      <HostProvider host={host}>
        <BreakdownPanel />
      </HostProvider>,
    );
    let opening: Promise<void> | undefined;
    act(() => {
      opening = useBreakdownStore.getState().open(host, {
        sentence: 'ライブハウスで歌う',
        source: { kind: 'manual' },
        focusCharIndex: 3, // 'ハ' inside "ライブハウス" [0, 6)
      });
    });
    const loadingBox = screen.getByTestId('breakdown-loading');
    for (let i = 0; i < 6; i++) {
      expect(glyphAt(loadingBox, i)).toHaveClass('is-focus');
    }
    expect(glyphAt(loadingBox, 0)).toHaveClass('is-focus-start');
    expect(glyphAt(loadingBox, 5)).toHaveClass('is-focus-end');
    expect(glyphAt(loadingBox, 6)).not.toHaveClass('is-focus');
    await act(async () => {
      await opening;
    });

    // Open a sentence with a multi-vocab chunk ("待ってくれよ" [4, 10) contains both 待つ [4, 6) and くれる [7, 9)).
    const waitExpl = explanationFor('ちょっと待ってくれよ、まだ話は終わってないんだから。', 'zh-CN');
    const matsu = vocabByLemma(waitExpl, '待つ');
    const kureru = vocabByLemma(waitExpl, 'くれる');
    const multiChunk = waitExpl.chunks.find((c) => c.vocabIds.includes(matsu.id) && c.vocabIds.includes(kureru.id))!;

    act(() => {
      opening = useBreakdownStore.getState().open(host, {
        sentence: waitExpl.sentence,
        source: { kind: 'manual' },
        focusCharIndex: multiChunk.charSpan[0],
      });
    });
    await act(async () => {
      await opening;
    });

    const chunkEl = screen.getByTestId(`chunk-${multiChunk.id}`);
    expect(within(chunkEl).getAllByRole('listitem').map((el) => el.getAttribute('data-testid'))).toEqual([
      `chunk-vocab-${matsu.id}`,
      `chunk-vocab-${kureru.id}`,
    ]);
    expect(screen.getByTestId(`chunk-vocab-${matsu.id}`)).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId(`chunk-vocab-${kureru.id}`)).not.toHaveAttribute('aria-current');

    // Click くれる ([7, 9)) inside ChunkCard: must NOT bubble to ChunkCard (which would reset focusCharIndex to 4),
    // and must NOT reorder [待つ, くれる].
    fireEvent.click(screen.getByTestId(`chunk-vocab-${kureru.id}`));
    expect(useBreakdownStore.getState().focusCharIndex).toBe(kureru.charSpan[0]);
    expect(screen.getByTestId(`chunk-vocab-${kureru.id}`)).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId(`chunk-vocab-${matsu.id}`)).not.toHaveAttribute('aria-current');
    expect(within(chunkEl).getAllByRole('listitem').map((el) => el.getAttribute('data-testid'))).toEqual([
      `chunk-vocab-${matsu.id}`,
      `chunk-vocab-${kureru.id}`,
    ]);
    const header = screen.getByTestId('breakdown-sentence');
    expect(glyphAt(header, matsu.charSpan[0])).not.toHaveClass('is-focus');
    expect(glyphAt(header, kureru.charSpan[0])).toHaveClass('is-focus', 'is-focus-start');
    expect(glyphAt(header, kureru.charSpan[1] - 1)).toHaveClass('is-focus', 'is-focus-end');
  });

  it('renders uncertain homograph candidates one-liner in compact mode and auto-scrolls only the primary linked item in VocabList', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const kakeru = vocabByLemma(KAKERU, 'かける');
    const { unmount } = render(
      <HostProvider host={host}>
        <AiBreakdownPanel explanation={KAKERU} focusCharIndex={kakeru.charSpan[0]} onFocusChange={() => {}} t={t} />
      </HostProvider>,
    );
    const compactKakeru = screen.getByTestId(`chunk-vocab-${kakeru.id}`);
    const toggle = await within(compactKakeru).findByTestId('vocab-uncertain-candidates');
    expect(toggle.textContent).toContain('📖 词典同音候选 (4)');
    unmount();

    // Auto-scroll guard in VocabList: index 0 does not scroll on initial mount; moving focus scrolls only the primary item.
    const scrolled: string[] = [];
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollSpy(this: Element) {
      const id = this.getAttribute('data-testid');
      if (id) scrolled.push(id);
    };
    try {
      const bando = vocabByLemma(BAND, 'バンド');
      const joshi = vocabByLemma(BAND, '女子');
      const linkedChunk0 = new Set([bando.id, joshi.id]);
      const { rerender } = render(
        <VocabList vocab={BAND.vocab} linkedIds={linkedChunk0} focusedVocabId={bando.id} onSelect={() => {}} t={t} />,
      );
      expect(scrolled).toEqual([]);

      rerender(<VocabList vocab={BAND.vocab} linkedIds={linkedChunk0} focusedVocabId={joshi.id} onSelect={() => {}} t={t} />);
      expect(scrolled).toEqual([`vocab-${joshi.id}`]);
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
    }
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

  it('ChunkCard chunk-vocab-tts-* speaks kana readings without selecting the chunk or vocab item', () => {
    const speakSpy = vi.spyOn(tts, 'speakJapanese').mockReturnValue(true);
    const onSelectChunk = vi.fn();
    const onSelectChar = vi.fn();
    const joshi = vocabByLemma(BAND, '女子');
    const joshiChunk = BAND.chunks.find((c) => c.vocabIds.includes(joshi.id))!;
    const chunkVocab = BAND.vocab.filter((v) => joshiChunk.vocabIds.includes(v.id));
    render(
      <ChunkCard
        chunk={joshiChunk}
        index={1}
        active
        vocab={chunkVocab}
        onSelect={onSelectChunk}
        onSelectChar={onSelectChar}
        t={t}
      />,
    );
    fireEvent.click(screen.getByTestId(`chunk-vocab-tts-${joshi.id}`));
    expect(speakSpy).toHaveBeenCalledWith('じょし');
    expect(onSelectChunk).not.toHaveBeenCalled();
    expect(onSelectChar).not.toHaveBeenCalled();
  });
});
