/**
 * P2 click-to-lookup card (spec §4.5 / §6 P2). When the user taps a character
 * in a subtitle / manga bubble or in the sticky sentence header, the text
 * after it is scanned with the clean-room deinflector (`host.dict.lookupPrefix`)
 * in parallel with the AI explanation, and the longest dictionary match is
 * shown immediately — with its deinflection chain (`食べさせられなかった ←
 * 食べる`), pitch contour, frequency rank and senses. Once the AI breakdown is
 * ready the card can be collapsed or dismissed.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InstantLookupMatch } from '@kotori/core';
import { useOptionalHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { speakJapanese } from '../../lib/tts';
import { cx } from '../m3/cx';
import { DictSenses } from './DictSenses';
import { FreqBadge, pickFrequencies, PitchAccentBadge } from './PitchAccentBadge';

/** Characters that never start a lookup (punctuation / whitespace). */
const NON_WORD_START = /^[\s、。，．！？!?,.「」『』（）()【】…・〜~ー―：:；;'"“”‘’]/u;

/** Max characters scanned after the tapped one. */
export const INSTANT_LOOKUP_MAX_LENGTH = 16;

export interface InstantLookupState {
  /** `${sentence}\u0000${charIndex}` the state belongs to. */
  readonly key: string;
  readonly charIndex: number;
  readonly loading: boolean;
  readonly matches: readonly InstantLookupMatch[];
}

/**
 * Runs `host.dict.lookupPrefix(sentence.slice(charIndex), 16)` whenever the
 * tapped position changes. `undefined` when there is nothing to look up
 * (no dictionary host, no index, punctuation).
 */
export function useInstantLookup(sentence: string | undefined, charIndex: number | undefined): InstantLookupState | undefined {
  const host = useOptionalHost();
  const [state, setState] = useState<InstantLookupState | undefined>(undefined);
  const dict = host?.dict;
  useEffect(() => {
    if (!dict || sentence === undefined || charIndex === undefined || charIndex < 0 || charIndex >= sentence.length) {
      setState(undefined);
      return;
    }
    const text = sentence.slice(charIndex);
    if (text.trim() === '' || NON_WORD_START.test(text)) {
      setState(undefined);
      return;
    }
    const key = `${sentence}\u0000${charIndex}`;
    let alive = true;
    setState({ key, charIndex, loading: true, matches: [] });
    dict
      .lookupPrefix(text, INSTANT_LOOKUP_MAX_LENGTH)
      .then((matches) => {
        if (alive) setState({ key, charIndex, loading: false, matches });
      })
      .catch(() => {
        if (alive) setState({ key, charIndex, loading: false, matches: [] });
      });
    return () => {
      alive = false;
    };
  }, [dict, sentence, charIndex]);
  return state;
}

export interface InstantDictPopupProps {
  readonly state: InstantLookupState | undefined;
  /** Show collapse / dismiss controls (AI breakdown finished). */
  readonly collapsible?: boolean;
  /** Start collapsed (collapsible only). */
  readonly defaultCollapsed?: boolean;
  readonly className?: string;
}

const KANA_ONLY = /^[\u3040-\u30ffー]+$/u;

function stop(e: { stopPropagation(): void }): void {
  e.stopPropagation();
}

export function InstantDictPopup({ state, collapsible = false, defaultCollapsed = false, className }: InstantDictPopupProps) {
  const t = useT();
  const rootRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [dismissed, setDismissed] = useState(false);
  const key = state?.key;
  const hasMatches = Boolean(state && !state.loading && state.matches.length > 0);
  useEffect(() => {
    setSelected(0);
    setDismissed(false);
  }, [key]);
  useLayoutEffect(() => {
    if (!key || !hasMatches || (collapsible && collapsed) || dismissed) return;
    let cur = rootRef.current?.parentElement ?? null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const oy = getComputedStyle(cur).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
        if (typeof cur.scrollTo === 'function') cur.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
        cur.scrollTop = 0;
        break;
      }
      cur = cur.parentElement;
    }
  }, [key, hasMatches, collapsible, collapsed, dismissed]);

  if (!state || dismissed) return null;
  if (!state.loading && state.matches.length === 0) return null;
  const match = state.matches[selected] ?? state.matches[0];
  const isCollapsed = collapsible && collapsed;
  // Distinct headwords for the "other matches" chips.
  const others = state.matches.map((m, i) => ({ m, i })).filter(({ i }) => i !== selected);

  return (
    <section ref={rootRef} className={cx('k-instant-dict', isCollapsed && 'is-collapsed', className)} data-testid="instant-dict-popup" aria-live="polite" aria-busy={state.loading || undefined}>
      <header className="k-instant-dict__bar">
        <span className="k-instant-dict__title">{t('dict.instant.title')}</span>
        {match && (
          <span className="k-instant-dict__headline" lang="ja" data-testid="instant-dict-headline">
            {match.surface !== match.lemma ? (
              <>
                <span className="k-instant-dict__surface">{match.surface}</span>
                <span className="k-instant-dict__arrow"> ← </span>
                <b>{match.lemma}</b>
              </>
            ) : (
              <b>{match.lemma}</b>
            )}
            {match.reading && match.reading !== match.lemma && <span className="k-instant-dict__reading">（{match.reading}）</span>}
          </span>
        )}
        {state.loading && !match && <span className="k-muted k-instant-dict__loading">{t('dict.instant.loading')}</span>}
        <span className="k-spacer" />
        {match && (
          <button
            type="button"
            className="k-vocab__tts k-instant-dict__btn"
            title={t('dict.tts')}
            data-testid="instant-dict-tts"
            onPointerDown={stop}
            onTouchStart={stop}
            onClick={(ev) => {
              stop(ev);
              speakJapanese(match.reading || match.lemma);
            }}
          >
            🔊
          </button>
        )}
        {collapsible && (
          <button
            type="button"
            className="k-instant-dict__btn"
            data-testid="instant-dict-collapse"
            aria-expanded={!isCollapsed}
            title={isCollapsed ? t('dict.instant.expand') : t('dict.instant.collapse')}
            onClick={() => setCollapsed((v) => !v)}
          >
            {isCollapsed ? '▾' : '▴'}
          </button>
        )}
        {collapsible && (
          <button type="button" className="k-instant-dict__btn" data-testid="instant-dict-dismiss" title={t('dict.instant.dismiss')} aria-label={t('dict.instant.dismiss')} onClick={() => setDismissed(true)}>
            ✕
          </button>
        )}
      </header>
      {match && !isCollapsed && (
        <div className="k-instant-dict__body">
          <div className="k-instant-dict__badges">
            <PitchAccentBadge pitches={match.pitches} testId="instant-pitch-badge" />
            {pickFrequencies(match.frequencies, KANA_ONLY.test(match.surface)).map((f) => (
              <FreqBadge key={f.dictId} badge={f} kanaLabel={match.reading} testId="instant-freq-badge" />
            ))}
            {match.deinflectChain.length > 0 && (
              <span className="k-instant-dict__chain" data-testid="instant-dict-chain" title={match.deinflectChain.join(' → ')}>
                {match.deinflectChain.map((r, i) => (
                  <span key={`${r}-${i}`} className="k-instant-dict__reason">
                    {r}
                  </span>
                ))}
              </span>
            )}
          </div>
          <DictSenses groups={match.senseGroups} showLabel={false} testId="instant-dict-senses" />
          {others.length > 0 && (
            <div className="k-instant-dict__others">
              <span className="k-muted">{t('dict.instant.others')}：</span>
              {others.slice(0, 5).map(({ m, i }) => (
                <button key={`${m.lemma}-${m.reading}-${i}`} type="button" className="k-instant-dict__other" lang="ja" data-testid={`instant-dict-other-${i}`} onClick={() => setSelected(i)}>
                  {m.lemma}
                  {m.reading && m.reading !== m.lemma ? `（${m.reading}）` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
