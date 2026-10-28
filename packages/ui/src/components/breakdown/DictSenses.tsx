/**
 * Dictionary sense list shared by `VocabList` (matched / uncertain states)
 * and `InstantDictPopup`: groups (one per dictionary headword row) of
 * numbered glosses with at most one bilingual example each. The first
 * `limit` senses are shown, with a toggle for the rest. The sense that best
 * matches the AI contextual meaning (`matchedSenseIdx`) is highlighted.
 */
import { useState } from 'react';
import type { DictionarySenseGroup } from '@kotori/core';
import { useT } from '../../i18n';
import { cx } from '../m3/cx';

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

export interface DictSensesProps {
  readonly groups: readonly DictionarySenseGroup[];
  /** Senses shown before "show all" (default 3). */
  readonly limit?: number;
  /** Show the `📖 词典释义` label (default true). */
  readonly showLabel?: boolean;
  /** Show the headword line of each group (default: when >1 group). */
  readonly showHeadwords?: boolean;
  readonly testId?: string;
}

export function DictSenses({ groups, limit = 3, showLabel = true, showHeadwords, testId = 'vocab-dict-senses' }: DictSensesProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const withSenses = groups.filter((g) => g.senses.length > 0);
  if (withSenses.length === 0) return null;
  const total = withSenses.reduce((n, g) => n + g.senses.length, 0);
  const headwords = showHeadwords ?? withSenses.length > 1;
  let budget = expanded ? Number.POSITIVE_INFINITY : limit;
  return (
    <div className="k-dict-senses" data-testid={testId}>
      {showLabel && <div className="k-dict-senses__label">{t('dict.senses')}</div>}
      {withSenses.map((g, gi) => {
        if (budget <= 0) return null;
        const visible = g.senses.slice(0, budget);
        budget -= visible.length;
        return (
          <div key={`${g.dictId}-${g.expression}-${g.reading}-${gi}`} className="k-dict-group">
            {(headwords || gi === 0) && (
              <div className="k-dict-group__head">
                {headwords && (
                  <span className="k-dict-group__hw" lang="ja">
                    {g.expression}
                    {g.reading && g.reading !== g.expression ? `【${g.reading}】` : ''}
                  </span>
                )}
                <span className="k-dict-group__src">{g.dictTitle}</span>
              </div>
            )}
            <ol className="k-dict-group__list">
              {visible.map((s, si) => {
                const matched = g.matchedSenseIdx === si;
                const ex = s.examples?.[0];
                return (
                  <li key={si} className={cx('k-dict-sense', matched && 'is-matched')} data-matched={matched || undefined} title={matched ? t('dict.matchedSense') : undefined}>
                    <span className="k-dict-sense__num">{CIRCLED[si] ?? `${si + 1}.`}</span>
                    <span className="k-dict-sense__body">
                      <span className="k-dict-sense__gloss">{s.gloss}</span>
                      {ex && (
                        <span className="k-dict-sense__example">
                          「<span lang="ja">{ex[0]}</span>
                          {ex[1] ? ` / ${ex[1]}` : ''}」
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
      {total > limit && (
        <button
          type="button"
          className="k-dict-senses__more"
          data-testid={`${testId}-toggle`}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? t('dict.showLess') : t('dict.showAll', { count: total })}
        </button>
      )}
    </div>
  );
}
