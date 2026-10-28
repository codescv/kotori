/**
 * One semantic chunk (意群): annotated surface with furigana, 📘 textbook form,
 * 🔥 spoken-language evolution, grammatical role, meaning and nuance. When
 * `active` it is highlighted and scrolled into view (`block: 'nearest'`) —
 * except the first card on mount, so the panel opens at `scrollTop = 0`.
 *
 * Redundant lines are dropped: the reading when it equals the surface (pure
 * kana chunks), and 📘 textbook form when it equals the surface with no 🔥
 * evolution. Romaji is shown only with `settings.anime.showRomaji`.
 */
import { memo, useEffect, useRef } from 'react';
import type { SemanticChunk, VocabEntry } from '@kotori/core';
import type { Translate } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { cx } from '../m3/cx';
import { kanaToRomaji } from './romaji';
import { RubyText } from './RubyText';

export interface ChunkCardProps {
  readonly chunk: SemanticChunk;
  readonly index: number;
  readonly active: boolean;
  readonly vocab: readonly VocabEntry[];
  readonly onSelect: (chunkId: string) => void;
  readonly t: Translate;
}

function ChunkCardImpl({ chunk, index, active, vocab, onSelect, t }: ChunkCardProps) {
  const ref = useRef<HTMLElement>(null);
  const mountedRef = useRef(false);
  const showRomaji = useSettingsStore((s) => s.settings.anime.showRomaji ?? false);
  useEffect(() => {
    const firstRun = !mountedRef.current;
    mountedRef.current = true;
    // The first card is already in view at the top: scrolling it "into view"
    // on open would push the sticky sentence / translation off-screen.
    if (firstRun && index === 0) return;
    // When the P2 InstantDictPopup is expanded at the top of the panel, do not
    // auto-scroll down — otherwise the sticky sentence obscures the popup.
    if (ref.current?.closest('.k-breakdown')?.querySelector('[data-testid="instant-dict-popup"]:not(.is-collapsed)')) {
      return;
    }
    if (active && ref.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      <p className="k-chunk-card__meaning">{chunk.meaning}</p>
      {chunk.nuance && <p className="k-chunk-card__nuance">💡 {chunk.nuance}</p>}
      {chunk.alignment === 'unaligned' && <p className="k-chunk-card__warn">{t('breakdown.unaligned')}</p>}
      {active && vocab.length > 0 && (
        <ul className="k-chunk-card__vocab">
          {vocab.map((v) => (
            <li key={v.id}>
              <span lang="ja">{v.lemma}</span> <span className="k-muted">{v.meaning}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export const ChunkCard = memo(ChunkCardImpl);
