/**
 * Vocabulary of the sentence; items linked to the focused chunk are
 * highlighted. Three adaptive states (spec §5.1), enriched at render time
 * from local dictionaries (never mutating the persisted explanation):
 *
 * 1. `matched`   — pitch contour + `[N]`, POS, `[JPDB #…]`, AI 🎯 contextual
 *                  meaning / 💡 nuance, and 📖 dictionary senses.
 * 2. `uncertain` — AI meaning + a collapsed `📖 词典同音候选 (n)` list; the
 *                  frequency badge is the kana-orthography rank when present.
 * 3. `empty`     — pitch / frequency when available; with zero dictionaries
 *                  the card is exactly the AI-only card (no placeholders).
 */
import { useEffect, useState } from 'react';
import type { Id, VocabCandidate, VocabEnrichment, VocabEntry } from '@kotori/core';
import { useOptionalHost } from '../../host/HostContext';
import type { Translate } from '../../i18n';
import { speakJapanese } from '../../lib/tts';
import { useDictStore } from '../../stores/dict';
import { cx } from '../m3/cx';
import { DictSenses } from './DictSenses';
import { FreqBadge, formatRank, pickFrequencies, PitchAccentBadge } from './PitchAccentBadge';
import { RubyText, tileSegments } from './RubyText';

export interface VocabListProps {
  readonly vocab: readonly VocabEntry[];
  readonly linkedIds: ReadonlySet<Id>;
  readonly onSelect: (charIndex: number) => void;
  readonly t: Translate;
  /** Precomputed enrichment (tests / callers that already have it); otherwise fetched via `useDictStore`. */
  readonly enrichment?: Readonly<Record<string, VocabEnrichment>> | undefined;
}

const KANA_ONLY = /^[\u3040-\u30ffー・\s]+$/u;
const HAS_KANA = /[\u3040-\u30ff]/u;
const HAS_KANJI = /[\u4e00-\u9fff\u3400-\u4dbf々]/u;

/**
 * Resolve the disambiguated Japanese reading to speak for a vocabulary item.
 *
 * Pure-Kanzi strings with zero kana (e.g. `女子`, `全部`, `今日`) are classified
 * as Chinese on many Android OEM / multilingual TTS engines and produce silent
 * output under `Locale.JAPAN`, and bare kanji lemmas misread homographs.
 */
export function vocabSpeechText(v: VocabEntry, e?: VocabEnrichment): string {
  const direct = v.lemmaReading?.trim();
  if (direct && !HAS_KANJI.test(direct)) return direct;
  if (v.lemmaRuby && v.lemmaRuby.length > 0) {
    const fromRuby = tileSegments(v.lemma, v.lemmaRuby)
      .map((seg) => seg.ruby || seg.base)
      .join('')
      .trim();
    if (fromRuby && HAS_KANA.test(fromRuby) && (!HAS_KANJI.test(fromRuby) || fromRuby !== v.lemma)) {
      return fromRuby;
    }
  }
  const dictReading = e?.pitches[0]?.reading?.trim() || e?.senseGroups[0]?.reading?.trim() || e?.reading?.trim();
  if (dictReading) return dictReading;
  return direct || v.lemma || v.surface;
}

/**
 * Render-time dictionary enrichment for `vocab` (LRU-cached in `useDictStore`,
 * re-fetched when `vocab` or `dictSetRevision` changes). `undefined` while
 * loading, without a host, or when `override` is given (then `override`).
 */
export function useVocabEnrichment(vocab: readonly VocabEntry[], override?: Readonly<Record<string, VocabEnrichment>>): Readonly<Record<string, VocabEnrichment>> | undefined {
  const host = useOptionalHost();
  const revision = useDictStore((s) => s.dictSetRevision);
  const [state, setState] = useState<{ vocab: readonly VocabEntry[]; value: Readonly<Record<string, VocabEnrichment>> | undefined }>(() => ({
    vocab,
    value: host && !override ? useDictStore.getState().peekEnrichment(host, vocab) : undefined,
  }));
  useEffect(() => {
    if (override || !host || vocab.length === 0) return;
    let alive = true;
    const store = useDictStore.getState();
    const cached = store.peekEnrichment(host, vocab);
    if (cached) {
      setState((s) => (s.vocab === vocab && s.value === cached ? s : { vocab, value: cached }));
      return;
    }
    store
      .enrich(host, vocab)
      .then((value) => {
        if (alive) setState({ vocab, value });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [host, vocab, revision, override]);
  if (override) return override;
  return state.vocab === vocab ? state.value : undefined;
}

function hasDictData(e: VocabEnrichment | undefined): e is VocabEnrichment {
  return e !== undefined && (e.status !== 'empty' || e.pitches.length > 0 || e.frequencies.length > 0);
}

function stop(e: { stopPropagation(): void }): void {
  e.stopPropagation();
}

function CandidateSummary({ c }: { readonly c: VocabCandidate }) {
  const pitch = c.pitches[0];
  const freq = pickFrequencies(c.frequencies, false)[0];
  return (
    <span className="k-dict-cand-chip" lang="ja">
      {c.expression}
      {pitch ? `[${pitch.position}]` : ''}
      {freq ? `(${formatRank(freq.value)})` : ''}
    </span>
  );
}

function UncertainCandidates({ candidates, t }: { readonly candidates: readonly VocabCandidate[]; readonly t: Translate }) {
  const [open, setOpen] = useState(false);
  if (candidates.length === 0) return null;
  return (
    <div className="k-dict-candidates">
      <button
        type="button"
        className="k-dict-candidates__toggle"
        data-testid="vocab-uncertain-candidates"
        aria-expanded={open}
        onClick={(e) => {
          stop(e);
          setOpen((v) => !v);
        }}
      >
        <span className="k-dict-candidates__label">{t('dict.candidates', { count: candidates.length })}：</span>
        {candidates.map((c, i) => (
          <span key={`${c.expression}-${i}`}>
            {i > 0 && <span className="k-dict-candidates__sep"> · </span>}
            <CandidateSummary c={c} />
          </span>
        ))}
        <span className="k-dict-candidates__caret" aria-hidden="true">
          {open ? ' ▴' : ' ▾'}
        </span>
      </button>
      {open && (
        <div className="k-dict-candidates__list" data-testid="vocab-candidate-list" onClick={stop}>
          {candidates.map((c, i) => (
            <div key={`${c.expression}-${i}`} className="k-dict-candidate" data-testid={`vocab-candidate-${c.expression}`}>
              <div className="k-dict-candidate__head">
                <span className="k-dict-candidate__hw" lang="ja">
                  {c.expression}
                  {c.reading && c.reading !== c.expression ? `（${c.reading}）` : ''}
                </span>
                <button
                  type="button"
                  className="k-vocab__tts"
                  title={t('dict.tts')}
                  data-testid={`vocab-candidate-tts-${i}`}
                  onPointerDown={stop}
                  onTouchStart={stop}
                  onClick={(ev) => {
                    stop(ev);
                    speakJapanese(c.reading || c.expression);
                  }}
                >
                  🔊
                </button>
                <PitchAccentBadge pitches={c.pitches} testId="candidate-pitch-badge" />
                {pickFrequencies(c.frequencies, false).map((f) => (
                  <FreqBadge key={f.dictId} badge={f} kanaLabel={c.reading} testId="candidate-freq-badge" />
                ))}
              </div>
              <DictSenses groups={c.senseGroups} showLabel={false} showHeadwords={false} limit={2} testId={`candidate-senses-${i}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VocabItem({ v, linked, onSelect, t, e }: { readonly v: VocabEntry; readonly linked: boolean; readonly onSelect: (i: number) => void; readonly t: Translate; readonly e: VocabEnrichment | undefined }) {
  const enriched = hasDictData(e);
  const status = enriched ? e.status : 'empty';
  const kanaSurface = KANA_ONLY.test(v.surface);
  const freqs = enriched ? pickFrequencies(e.frequencies, status === 'uncertain' || kanaSurface) : [];
  const pitches = enriched && status !== 'uncertain' ? e.pitches : [];
  const kanaLabel = v.lemmaReading || v.surface;
  return (
    <li
      className={cx('k-vocab', linked && 'is-linked', enriched && `is-dict-${status}`)}
      data-testid={`vocab-${v.id}`}
      data-dict-status={enriched ? status : undefined}
      aria-current={linked || undefined}
      onClick={() => v.charSpan[1] > v.charSpan[0] && onSelect(v.charSpan[0])}
    >
      <div className="k-vocab__head">
        <span className="k-vocab__lemma">
          <RubyText text={v.lemma} segments={v.lemmaRuby} />
        </span>
        <button
          type="button"
          className="k-vocab__tts"
          title={t('dict.tts')}
          data-testid={`vocab-tts-${v.id}`}
          onPointerDown={stop}
          onTouchStart={stop}
          onClick={(ev) => {
            stop(ev);
            speakJapanese(vocabSpeechText(v, e));
          }}
        >
          🔊
        </button>
        {pitches.length > 0 && <PitchAccentBadge pitches={pitches} />}
        <span className={cx('k-pos', `k-pos--${v.partOfSpeech}`)}>{t(`pos.${v.partOfSpeech}`)}</span>
        {freqs.map((f) => (
          <FreqBadge key={f.dictId} badge={f} kanaLabel={kanaLabel} />
        ))}
        {v.jlpt && freqs.length === 0 && <span className="k-jlpt">{v.jlpt}</span>}
      </div>
      {enriched ? (
        <>
          <div className="k-vocab__meaning k-vocab__ctx" data-testid={`vocab-meaning-${v.id}`}>
            <span className="k-vocab__label">{t('dict.contextMeaning')}：</span>
            {v.surface !== v.lemma && (
              <span className="k-vocab__surface" lang="ja">
                {v.surface} ←{' '}
              </span>
            )}
            {v.meaning}
            {v.conjugation && (
              <span className="k-vocab__conj-chip" title={t('breakdown.conjugation')}>
                {v.conjugation}
              </span>
            )}
          </div>
          {v.notes && (
            <div className="k-vocab__notes">
              <span className="k-vocab__label">{t('dict.nuance')}：</span>
              {v.notes}
            </div>
          )}
          {status === 'matched' && <DictSenses groups={e.senseGroups} />}
          {status === 'uncertain' && <UncertainCandidates candidates={e.candidates ?? []} t={t} />}
        </>
      ) : (
        <>
          <div className="k-vocab__meaning">
            {v.surface !== v.lemma && (
              <span className="k-vocab__surface" lang="ja">
                {v.surface} ←{' '}
              </span>
            )}
            {v.meaning}
          </div>
          {v.conjugation && (
            <div className="k-vocab__conj">
              {t('breakdown.conjugation')}：{v.conjugation}
            </div>
          )}
          {v.notes && <div className="k-vocab__notes">{v.notes}</div>}
        </>
      )}
    </li>
  );
}

export function VocabList({ vocab, linkedIds, onSelect, t, enrichment }: VocabListProps) {
  const enrichments = useVocabEnrichment(vocab, enrichment);
  if (vocab.length === 0) return null;
  return (
    <ul className="k-vocab-list">
      {vocab.map((v) => (
        <VocabItem key={v.id} v={v} linked={linkedIds.has(v.id)} onSelect={onSelect} t={t} e={enrichments?.[v.id]} />
      ))}
    </ul>
  );
}
