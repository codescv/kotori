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
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Id, VocabCandidate, VocabEnrichment, VocabEntry } from '@kotori/core';
import { useOptionalHost } from '../../host/HostContext';
import type { Translate } from '../../i18n';
import { speakJapanese } from '../../lib/tts';
import { useDictStore } from '../../stores/dict';
import { cx } from '../m3/cx';
import { DictSenses } from './DictSenses';
import { FreqBadge, formatRank, pickFrequencies, PitchAccentBadge } from './PitchAccentBadge';
import { RubyText, tileSegments } from './RubyText';

export interface VocabItemProps {
  readonly item: VocabEntry;
  readonly linked?: boolean | undefined;
  readonly primaryLinked?: boolean | undefined;
  readonly index?: number | undefined;
  readonly compact?: boolean | undefined;
  readonly enrichment?: VocabEnrichment | undefined;
  readonly onSelect?: ((charIndex: number) => void) | undefined;
  readonly t: Translate;
}

export interface VocabListProps {
  readonly vocab: readonly VocabEntry[];
  readonly linkedIds: ReadonlySet<Id>;
  readonly focusedVocabId?: Id | undefined;
  readonly primaryLinkedId?: Id | undefined;
  readonly onSelect: (charIndex: number) => void;
  readonly t: Translate;
  /** Precomputed enrichment map (e.g. lifted in `AiBreakdownPanel`); otherwise fetched via `useDictStore`. */
  readonly enrichments?: ReadonlyMap<string, VocabEnrichment> | undefined;
  /** Precomputed enrichment record (tests / callers that already have it); otherwise fetched via `useDictStore`. */
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

function isReadonlyMap(
  v: ReadonlyMap<string, VocabEnrichment> | Readonly<Record<string, VocabEnrichment>>,
): v is ReadonlyMap<string, VocabEnrichment> {
  return v instanceof Map || typeof (v as ReadonlyMap<string, VocabEnrichment>).get === 'function';
}

function recordToMap(rec: Readonly<Record<string, VocabEnrichment>> | undefined): ReadonlyMap<string, VocabEnrichment> | undefined {
  if (!rec) return undefined;
  return new Map(Object.entries(rec));
}

/**
 * Render-time dictionary enrichment for `vocab` (LRU-cached in `useDictStore`,
 * re-fetched when `vocab` or `dictSetRevision` changes). `undefined` while
 * loading, without a host, or when `override` is given (then `override`).
 */
export function useVocabEnrichment(
  vocab: readonly VocabEntry[],
  override?: ReadonlyMap<string, VocabEnrichment> | Readonly<Record<string, VocabEnrichment>>,
): ReadonlyMap<string, VocabEnrichment> | undefined {
  const host = useOptionalHost();
  const revision = useDictStore((s) => s.dictSetRevision);
  const overrideMap = useMemo<ReadonlyMap<string, VocabEnrichment> | undefined>(() => {
    if (!override) return undefined;
    return isReadonlyMap(override) ? override : new Map(Object.entries(override));
  }, [override]);
  const [state, setState] = useState<{
    vocab: readonly VocabEntry[];
    raw: Readonly<Record<string, VocabEnrichment>> | undefined;
    value: ReadonlyMap<string, VocabEnrichment> | undefined;
  }>(() => {
    const raw = host && !override ? useDictStore.getState().peekEnrichment(host, vocab) : undefined;
    return { vocab, raw, value: recordToMap(raw) };
  });
  useEffect(() => {
    if (override || !host || vocab.length === 0) return;
    let alive = true;
    const store = useDictStore.getState();
    const cached = store.peekEnrichment(host, vocab);
    if (cached) {
      setState((s) => (s.vocab === vocab && s.raw === cached ? s : { vocab, raw: cached, value: recordToMap(cached) }));
      return;
    }
    void (async () => {
      try {
        if (host.dict) {
          await store.ensureLoaded(host);
          if (!alive || useDictStore.getState().dictSetRevision !== revision) return;
        }
        const afterLoad = store.peekEnrichment(host, vocab);
        if (afterLoad) {
          setState((s) =>
            s.vocab === vocab && s.raw === afterLoad ? s : { vocab, raw: afterLoad, value: recordToMap(afterLoad) },
          );
          return;
        }
        const raw = await store.enrich(host, vocab);
        if (alive && useDictStore.getState().dictSetRevision === revision) {
          setState({ vocab, raw, value: recordToMap(raw) });
        }
      } catch {
        // Ignore dictionary RPC errors; cards degrade cleanly to AI-only state.
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, vocab, revision, override]);
  if (overrideMap) return overrideMap;
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

export function VocabItem({
  item: v,
  linked = false,
  primaryLinked = false,
  index = 0,
  compact = false,
  enrichment: e,
  onSelect,
  t,
}: VocabItemProps) {
  const ref = useRef<HTMLLIElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    const firstRun = !mountedRef.current;
    mountedRef.current = true;
    if (firstRun && index === 0) return;
    if (primaryLinked && ref.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [primaryLinked, index]);

  const enriched = hasDictData(e);
  const status = enriched ? e.status : 'empty';
  const kanaSurface = KANA_ONLY.test(v.surface);
  const freqs = enriched ? pickFrequencies(e.frequencies, status === 'uncertain' || kanaSurface) : [];
  const pitches = enriched && status !== 'uncertain' ? e.pitches : [];
  const kanaLabel = v.lemmaReading || v.surface;
  return (
    <li
      ref={ref}
      className={cx('k-vocab', compact && 'k-vocab--compact', linked && 'is-linked', enriched && `is-dict-${status}`)}
      data-testid={compact ? `chunk-vocab-${v.id}` : `vocab-${v.id}`}
      data-dict-status={enriched ? status : undefined}
      aria-current={linked || undefined}
      onClick={(ev) => {
        ev.stopPropagation();
        if (v.charSpan[1] > v.charSpan[0]) {
          onSelect?.(v.charSpan[0]);
        }
      }}
    >
      <div className="k-vocab__head">
        <span className="k-vocab__lemma">
          <RubyText text={v.lemma} segments={v.lemmaRuby} />
        </span>
        <button
          type="button"
          className={cx('k-vocab__tts', compact && 'k-chunk-card__tts')}
          title={t('dict.tts')}
          data-testid={compact ? `chunk-vocab-tts-${v.id}` : `vocab-tts-${v.id}`}
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
        {!compact && <span className={cx('k-pos', `k-pos--${v.partOfSpeech}`)}>{t(`pos.${v.partOfSpeech}`)}</span>}
        {freqs.map((f) => (
          <FreqBadge key={f.dictId} badge={f} kanaLabel={kanaLabel} />
        ))}
        {!compact && v.jlpt && freqs.length === 0 && <span className="k-jlpt">{v.jlpt}</span>}
      </div>
      {compact ? (
        <>
          <div className="k-vocab__meaning k-vocab__ctx" data-testid={`chunk-vocab-meaning-${v.id}`}>
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
          {enriched && status === 'matched' && <DictSenses groups={e.senseGroups} limit={2} showLabel={false} />}
          {enriched && status === 'uncertain' && <UncertainCandidates candidates={e.candidates ?? []} t={t} />}
        </>
      ) : enriched ? (
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

export function VocabList({ vocab, linkedIds, focusedVocabId, primaryLinkedId, onSelect, t, enrichments, enrichment }: VocabListProps) {
  const resolved = useVocabEnrichment(vocab, enrichments ?? enrichment);
  const firstLinkedId = useMemo(() => {
    for (const id of linkedIds) return id;
    return undefined;
  }, [linkedIds]);
  const primaryId = focusedVocabId ?? primaryLinkedId ?? firstLinkedId;
  if (vocab.length === 0) return null;
  return (
    <ul className="k-vocab-list">
      {vocab.map((v, i) => {
        const isLinked = linkedIds.has(v.id) || focusedVocabId === v.id;
        return (
          <VocabItem
            key={v.id}
            item={v}
            index={i}
            linked={isLinked}
            primaryLinked={isLinked && v.id === primaryId}
            enrichment={resolved?.get(v.id)}
            onSelect={onSelect}
            t={t}
          />
        );
      })}
    </ul>
  );
}
