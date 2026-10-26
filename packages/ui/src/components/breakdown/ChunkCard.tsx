/**
 * One semantic chunk (意群): annotated surface with furigana, 📘 textbook form,
 * 🔥 spoken-language evolution, grammatical role, meaning and nuance. When
 * `active` it is highlighted and scrolled into view (`block: 'nearest'`).
 */
import { memo, useEffect, useRef } from 'react';
import type { SemanticChunk, VocabEntry } from '@kotori/core';
import type { Translate } from '../../i18n';
import { cx } from '../m3/cx';
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
  useEffect(() => {
    if (active && ref.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active]);
  const evolved = chunk.spokenEvolution;
  const showTextbook = chunk.textbookForm.length > 0;
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
      <div className="k-chunk-card__reading">{chunk.reading}</div>
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
