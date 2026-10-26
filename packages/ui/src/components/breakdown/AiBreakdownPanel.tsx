/**
 * AI breakdown panel.
 *
 * `AiBreakdownPanel` is presentational: `{ explanation, focusCharIndex,
 * onFocusChange, onFollowUp }` (+ thread state). The sentence (RubyText) and
 * the chunk cards are wired through `useBreakdownSelection`, so clicking a
 * character highlights its chunk card (and scrolls to it) and clicking a card
 * highlights its span in the sentence — both purely local, 0 ms.
 *
 * `BreakdownPanel` is the connected container used by the player and the
 * reader: it reads `useBreakdownStore` and renders loading / error / empty.
 */
import { useCallback, useState } from 'react';
import type { FollowUpMessage, SentenceExplanation } from '@kotori/core';
import { useHost } from '../../host/HostContext';
import { useT, type Translate } from '../../i18n';
import { useBreakdownStore } from '../../stores/breakdown';
import { vocabForChunk } from '../../lib/explanation';
import { Button } from '../m3/Button';
import { cx } from '../m3/cx';
import { IconButton } from '../m3/IconButton';
import { LinearProgress } from '../m3/Progress';
import { Tabs } from '../m3/Tabs';
import { ChunkCard } from './ChunkCard';
import { FollowUpThread } from './FollowUpThread';
import { GrammarList } from './GrammarList';
import { RubyText } from './RubyText';
import { useBreakdownSelection } from './useBreakdownSelection';
import { VocabList } from './VocabList';

export interface AiBreakdownPanelProps {
  readonly explanation: SentenceExplanation;
  readonly focusCharIndex: number | undefined;
  readonly onFocusChange: (charIndex: number) => void;
  readonly onFollowUp?: (question: string) => void;
  readonly thread?: readonly FollowUpMessage[];
  readonly streamingText?: string | undefined;
  readonly followUpPending?: boolean;
  readonly onRegenerate?: () => void;
  readonly t?: Translate;
  readonly className?: string | undefined;
}

type Section = 'chunks' | 'vocab' | 'grammar';

export function AiBreakdownPanel({
  explanation,
  focusCharIndex,
  onFocusChange,
  onFollowUp,
  thread = [],
  streamingText,
  followUpPending = false,
  onRegenerate,
  t: tProp,
  className,
}: AiBreakdownPanelProps) {
  const tHook = useT();
  const t = tProp ?? tHook;
  const sel = useBreakdownSelection(explanation, focusCharIndex, onFocusChange);
  const [section, setSection] = useState<Section>('chunks');
  const copy = useCallback(() => void navigator.clipboard?.writeText(explanation.sentence).catch(() => {}), [explanation.sentence]);

  return (
    <div className={cx('k-breakdown', className)} data-testid="ai-breakdown-panel">
      {/* Direct child of the scroll content so `position: sticky` keeps it in view. */}
      <div className="k-breakdown__sentence" data-testid="breakdown-sentence">
        <RubyText
          text={explanation.sentence}
          segments={explanation.ruby}
          highlight={sel.highlightSpan}
          focusIndex={focusCharIndex}
          onCharClick={sel.selectChar}
        />
      </div>
      <section className="k-breakdown__sentence-block">
        <div className="k-breakdown__meta">
          {explanation.register && <span className="k-tag">{t(`breakdown.register.${explanation.register}`)}</span>}
          {explanation.tone && <span className="k-tag k-tag--tone">{explanation.tone}</span>}
          {explanation.fromCache && <span className="k-tag k-tag--muted">{t('breakdown.fromCache')}</span>}
          <span className="k-breakdown__meta-spacer" />
          <IconButton icon="file" size="small" label={t('breakdown.copy')} onClick={copy} />
          {onRegenerate && <IconButton icon="refresh" size="small" label={t('breakdown.regenerate')} onClick={onRegenerate} />}
        </div>
        <p className="k-breakdown__translation">{explanation.translation}</p>
        {explanation.literalTranslation && (
          <p className="k-breakdown__literal">
            <span className="k-muted">{t('breakdown.literal')}：</span>
            {explanation.literalTranslation}
          </p>
        )}
      </section>

      <Tabs<Section>
        className="k-breakdown__tabs"
        value={section}
        onChange={setSection}
        tabs={[
          { value: 'chunks', label: `${t('breakdown.chunks')} ${explanation.chunks.length}` },
          { value: 'vocab', label: `${t('breakdown.vocab')} ${explanation.vocab.length}`, badge: sel.linkedVocabIds.size },
          { value: 'grammar', label: `${t('breakdown.grammar')} ${explanation.grammar.length}`, badge: sel.linkedGrammarIds.size },
        ]}
      />

      <div className="k-breakdown__section">
        {section === 'chunks' && (
          <div className="k-chunk-list" role="list">
            {explanation.chunks.map((chunk, i) => (
              <ChunkCard
                key={chunk.id}
                chunk={chunk}
                index={i}
                active={i === sel.activeChunkIndex}
                vocab={i === sel.activeChunkIndex ? vocabForChunk(explanation, chunk) : []}
                onSelect={sel.selectChunk}
                t={t}
              />
            ))}
          </div>
        )}
        {section === 'vocab' && <VocabList vocab={explanation.vocab} linkedIds={sel.linkedVocabIds} onSelect={sel.selectChar} t={t} />}
        {section === 'grammar' && (
          <GrammarList grammar={explanation.grammar} chunks={explanation.chunks} linkedIds={sel.linkedGrammarIds} onSelectChunk={sel.selectChunk} />
        )}
      </div>

      {onFollowUp && (
        <>
          <h3 className="k-breakdown__subhead">{t('followup.title')}</h3>
          <FollowUpThread thread={thread} streamingText={streamingText} pending={followUpPending} onAsk={onFollowUp} t={t} />
        </>
      )}
    </div>
  );
}

/** Skeleton shown while Gemini works (sentence is already known → render it). */
export function BreakdownSkeleton({ sentence, focusCharIndex, t }: { readonly sentence: string; readonly focusCharIndex?: number | undefined; readonly t: Translate }) {
  return (
    <div className="k-breakdown is-loading" data-testid="breakdown-loading" aria-busy="true">
      <div className="k-breakdown__sentence">
        <RubyText text={sentence} focusIndex={focusCharIndex} />
      </div>
      <LinearProgress label={t('breakdown.loading')} />
      <p className="k-muted">{t('breakdown.loading')}</p>
      <div className="k-skeleton k-skeleton--line" />
      <div className="k-skeleton k-skeleton--card" />
      <div className="k-skeleton k-skeleton--card" />
    </div>
  );
}

/** Store-connected panel (player / reader). */
export function BreakdownPanel({ className }: { readonly className?: string | undefined }) {
  const host = useHost();
  const t = useT();
  const status = useBreakdownStore((s) => s.status);
  const explanation = useBreakdownStore((s) => s.explanation);
  const request = useBreakdownStore((s) => s.request);
  const focusCharIndex = useBreakdownStore((s) => s.focusCharIndex);
  const error = useBreakdownStore((s) => s.error);
  const thread = useBreakdownStore((s) => s.thread);
  const streamingText = useBreakdownStore((s) => s.streamingText);
  const followUpPending = useBreakdownStore((s) => s.followUpPending);
  const setFocus = useBreakdownStore((s) => s.setFocus);
  const askFollowUp = useBreakdownStore((s) => s.askFollowUp);
  const retry = useBreakdownStore((s) => s.retry);

  const onFollowUp = useCallback((q: string) => void askFollowUp(host, q), [askFollowUp, host]);
  const onRegenerate = useCallback(() => void retry(host), [retry, host]);

  if (status === 'loading' && request) return <BreakdownSkeleton sentence={request.sentence} focusCharIndex={focusCharIndex} t={t} />;
  if (status === 'error' && error) {
    const known = ['ai-auth', 'ai-quota', 'ai-timeout'] as const;
    const msg = (known as readonly string[]).includes(error.code)
      ? t(`breakdown.error.${error.code as (typeof known)[number]}`)
      : t('breakdown.error.generic', { message: error.message });
    return (
      <div className={cx('k-breakdown k-breakdown--error', className)} role="alert">
        {request && (
          <div className="k-breakdown__sentence">
            <RubyText text={request.sentence} />
          </div>
        )}
        <p>{msg}</p>
        <Button variant="tonal" icon="refresh" onClick={onRegenerate}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (status === 'ready' && explanation) {
    return (
      <AiBreakdownPanel
        className={className}
        explanation={explanation}
        focusCharIndex={focusCharIndex}
        onFocusChange={setFocus}
        onFollowUp={onFollowUp}
        thread={thread}
        streamingText={streamingText}
        followUpPending={followUpPending}
        onRegenerate={onRegenerate}
        t={t}
      />
    );
  }
  return (
    <div className={cx('k-breakdown k-breakdown--empty', className)}>
      <p className="k-muted">{t('breakdown.empty')}</p>
    </div>
  );
}
