/**
 * One semantic chunk (意群): annotated surface with furigana, 📘 textbook form,
 * 🔥 spoken-language evolution, 📐 inline grammar, grammatical role, meaning,
 * nuance, and active-expand vocabulary (full `<VocabItem compact />` on the
 * active card, clickable 1-line lemma chips on inactive cards).
 *
 * When `active` it is highlighted and scrolled into view (`block: 'nearest'`,
 * `behavior: 'auto'`) — except the first card on mount, so the panel opens at
 * `scrollTop = 0`.
 *
 * Redundant lines are dropped: the reading when it equals the surface (pure
 * kana chunks), and 📘 textbook form when it equals the surface with no 🔥
 * evolution. Romaji is shown only with `settings.anime.showRomaji`.
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import type { GrammarPoint, Id, SemanticChunk, VocabEnrichment, VocabEntry } from '@kotori/core';
import type { Translate } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { cx } from '../m3/cx';
import { kanaToRomaji } from './romaji';
import { RubyText } from './RubyText';
import { VocabItem } from './VocabList';

export interface ChunkCardProps {
  readonly chunk: SemanticChunk;
  readonly index: number;
  readonly active: boolean;
  readonly vocab: readonly VocabEntry[];
  readonly grammar?: readonly GrammarPoint[] | undefined;
  readonly enrichments?: ReadonlyMap<string, VocabEnrichment> | undefined;
  readonly focusedVocabId?: Id | undefined;
  readonly onSelect: (chunkId: string) => void;
  readonly onSelectChar?: ((charIndex: number) => void) | undefined;
  readonly t: Translate;
}

const normPattern = (s: string): string => s.trim().replace(/^[~〜～]+/u, '');

function ChunkCardImpl({
  chunk,
  index,
  active,
  vocab,
  grammar,
  enrichments,
  focusedVocabId,
  onSelect,
  onSelectChar,
  t,
}: ChunkCardProps) {
  const ref = useRef<HTMLElement>(null);
  const mountedRef = useRef(false);
  const showRomaji = useSettingsStore((s) => s.settings.anime.showRomaji ?? false);
  const orderedVocab = useMemo(() => [...vocab].sort((a, b) => a.charSpan[0] - b.charSpan[0]), [vocab]);
  useEffect(() => {
    const firstRun = !mountedRef.current;
    mountedRef.current = true;
    // The first card is already in view at the top: scrolling it "into view"
    // on open would push the sticky sentence / translation off-screen.
    if (firstRun && index === 0) return;
    if (active) {
      ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    }
  }, [active, index]);

  const evolved = chunk.spokenEvolution;
  const surface = chunk.surface.trim();
  const reading = chunk.reading.trim();
  const hasKanji = /[\u4e00-\u9faf\u3400-\u4dbf々]/.test(surface);
  const showReading = hasKanji && reading !== '' && reading !== surface;
  const romaji = showRomaji ? kanaToRomaji(reading || surface) : '';
  const textbook = chunk.textbookForm.trim();
  const showTextbook = textbook !== '' && (textbook !== surface || evolved !== undefined);
  const formality = evolved?.formality;

  const grammarList = grammar ?? [];
  const patternTrimmed = chunk.grammarPattern?.trim() ?? '';
  const showGrammarPattern =
    patternTrimmed !== '' && !grammarList.some((g) => normPattern(g.pattern) === normPattern(patternTrimmed));
  const hasGrammar = grammarList.length > 0 || showGrammarPattern;

  return (
    <article
      ref={ref}
      className={cx('k-chunk-card', active && 'is-active', chunk.alignment === 'unaligned' && 'is-unaligned', evolved && 'has-evolution')}
      aria-current={active || undefined}
      data-chunk-id={chunk.id}
      data-testid={`chunk-${chunk.id}`}
      tabIndex={0}
      onClick={() => onSelect(chunk.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(chunk.id);
        }
      }}
    >
      <header className="k-chunk-card__head">
        <span className="k-chunk-card__index">{index + 1}</span>
        <span className="k-chunk-card__surface">
          <RubyText text={chunk.surface} segments={chunk.ruby} offset={chunk.charSpan[0]} />
        </span>
        <span className="k-chunk-card__role">{chunk.role}</span>
      </header>
      {(showReading || romaji) && (
        <div className="k-chunk-card__reading" data-testid={`chunk-reading-${chunk.id}`}>
          {showReading && <span lang="ja">{chunk.reading}</span>}
          {romaji && <span className="k-chunk-card__romaji">{romaji}</span>}
        </div>
      )}
      {showTextbook && (
        <div className="k-chunk-card__row k-chunk-card__textbook">
          <span className="k-chunk-card__emoji" aria-hidden>
            📘
          </span>
          <span className="k-chunk-card__row-label">{t('breakdown.textbook')}</span>
          <span className="k-chunk-card__row-value" lang="ja">
            {chunk.textbookForm}
          </span>
        </div>
      )}
      {evolved && (
        <div className="k-chunk-card__row k-chunk-card__spoken">
          <span className="k-chunk-card__emoji" aria-hidden>
            🔥
          </span>
          <span className="k-chunk-card__row-label">
            {t('breakdown.spoken')} · <b>{evolved.kind}</b>
          </span>
          <span className="k-chunk-card__row-value">{evolved.derivation}</span>
          {formality !== undefined && (
            <span className="k-formality" title={`${t('breakdown.formality')} ${Math.round(formality * 100)}%`}>
              <span className="k-formality__bar" style={{ width: `${Math.round(formality * 100)}%` }} />
            </span>
          )}
        </div>
      )}
      {hasGrammar && (
        <div className="k-chunk-card__grammar-list">
          {grammarList.map((g) => {
            const gMeaning = (g as { readonly meaning?: string }).meaning?.trim();
            const gExpl = g.explanation?.trim();
            const grammarText = gMeaning
              ? `${gMeaning}${gExpl && gExpl !== gMeaning && gExpl !== chunk.meaning ? ` — ${gExpl}` : ''}`
              : gExpl && gExpl !== chunk.meaning
                ? gExpl
                : '';
            return (
              <div key={g.id} className="k-chunk-card__grammar-item" data-testid={`chunk-grammar-${g.id}`}>
                <span className="k-chunk-card__evo-tag k-chunk-card__evo-tag--grammar" lang="ja">
                  📐 {g.pattern}
                  {g.jlpt ? ` · ${g.jlpt}` : ''}
                </span>
                {grammarText && <span className="k-chunk-card__grammar-meaning">{grammarText}</span>}
              </div>
            );
          })}
          {showGrammarPattern && (
            <div className="k-chunk-card__grammar-item">
              <span
                className="k-chunk-card__evo-tag k-chunk-card__evo-tag--grammar"
                data-testid={`chunk-grammar-pattern-${chunk.id}`}
                lang="ja"
              >
                📐 {patternTrimmed}
              </span>
            </div>
          )}
        </div>
      )}
      <p className="k-chunk-card__meaning">{chunk.meaning}</p>
      {chunk.nuance && <p className="k-chunk-card__nuance">💡 {chunk.nuance}</p>}
      {chunk.alignment === 'unaligned' && <p className="k-chunk-card__warn">{t('breakdown.unaligned')}</p>}
      {active && orderedVocab.length > 0 && (
        <ul className="k-chunk-card__vocab">
          {orderedVocab.map((v) => (
            <VocabItem
              key={v.id}
              item={v}
              compact
              testIdPrefix="chunk-vocab"
              enrichment={enrichments?.get(v.id)}
              linked={focusedVocabId === v.id}
              onSelect={onSelectChar}
              t={t}
            />
          ))}
        </ul>
      )}
      {!active && orderedVocab.length > 0 && (
        <div className="k-chunk-card__vocab-chips" role="list">
          {orderedVocab.map((v) => (
            <button
              key={v.id}
              type="button"
              className="k-chunk-vocab-chip"
              data-testid={`chunk-vocab-chip-${v.id}`}
              onClick={(ev) => {
                ev.stopPropagation();
                const targetChar = v.charSpan[1] > v.charSpan[0] ? v.charSpan[0] : chunk.charSpan[0];
                if (onSelectChar) onSelectChar(targetChar);
                else onSelect(chunk.id);
              }}
            >
              <span className="k-chunk-vocab-chip__lemma" lang="ja">
                {v.lemma}
              </span>
              <span className="k-chunk-vocab-chip__meaning">{v.meaning}</span>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

export const ChunkCard = memo(ChunkCardImpl);
