/** Grammar patterns; those instantiated by the focused chunk are highlighted. */
import type { GrammarPoint, Id, SemanticChunk } from '@kotori/core';
import { cx } from '../m3/cx';

export interface GrammarListProps {
  readonly grammar: readonly GrammarPoint[];
  readonly chunks: readonly SemanticChunk[];
  readonly linkedIds: ReadonlySet<Id>;
  readonly onSelectChunk: (chunkId: Id) => void;
}

export function GrammarList({ grammar, chunks, linkedIds, onSelectChunk }: GrammarListProps) {
  if (grammar.length === 0) return null;
  return (
    <ul className="k-grammar-list">
      {grammar.map((g) => {
        const linked = linkedIds.has(g.id);
        const surfaces = g.chunkIds.map((id) => chunks.find((c) => c.id === id)?.surface).filter(Boolean);
        return (
          <li
            key={g.id}
            className={cx('k-grammar', linked && 'is-linked')}
            data-testid={`grammar-${g.id}`}
            aria-current={linked || undefined}
            onClick={() => g.chunkIds[0] !== undefined && onSelectChunk(g.chunkIds[0])}
          >
            <div className="k-grammar__head">
              <span className="k-grammar__pattern" lang="ja">
                {g.pattern}
              </span>
              {g.jlpt && <span className="k-jlpt">{g.jlpt}</span>}
              {surfaces.length > 0 && (
                <span className="k-grammar__surfaces" lang="ja">
                  「{surfaces.join('」「')}」
                </span>
              )}
            </div>
            <p className="k-grammar__text">{g.explanation}</p>
          </li>
        );
      })}
    </ul>
  );
}
