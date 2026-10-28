/** Vocabulary of the sentence; items linked to the focused chunk are highlighted. Pitch accent is not shown. */
import type { Id, VocabEntry } from '@kotori/core';
import type { Translate } from '../../i18n';
import { speakJapanese } from '../../lib/tts';
import { cx } from '../m3/cx';
import { RubyText } from './RubyText';

export interface VocabListProps {
  readonly vocab: readonly VocabEntry[];
  readonly linkedIds: ReadonlySet<Id>;
  readonly onSelect: (charIndex: number) => void;
  readonly t: Translate;
}

export function VocabList({ vocab, linkedIds, onSelect, t }: VocabListProps) {
  if (vocab.length === 0) return null;
  return (
    <ul className="k-vocab-list">
      {vocab.map((v) => {
        const linked = linkedIds.has(v.id);
        return (
          <li
            key={v.id}
            className={cx('k-vocab', linked && 'is-linked')}
            data-testid={`vocab-${v.id}`}
            aria-current={linked || undefined}
            onClick={() => v.charSpan[1] > v.charSpan[0] && onSelect(v.charSpan[0])}
          >
            <div className="k-vocab__head">
              <span className="k-vocab__lemma">
                <RubyText text={v.lemma} segments={v.lemmaRuby} />
              </span>
              {/* Pitch accent is intentionally not rendered (model output was unreliable). */}
              <span className={cx('k-pos', `k-pos--${v.partOfSpeech}`)}>{t(`pos.${v.partOfSpeech}`)}</span>
              {v.jlpt && <span className="k-jlpt">{v.jlpt}</span>}
              <button
                type="button"
                className="k-vocab__tts"
                title="朗读词汇"
                data-testid={`vocab-tts-${v.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  speakJapanese(v.lemma || v.surface);
                }}
              >
                🔊
              </button>
            </div>
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
          </li>
        );
      })}
    </ul>
  );
}
