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
 *
 * Focus contract: the panel always opens at `scrollTop = 0` when the first
 * chunk (or none) is focused, so the sticky sentence, the translation and the
 * first chunk are visible immediately (the follow-up thread never scrolls on
 * mount). Subtitle sources get `🔊 原声`, `🐢 0.75×` slow replay and `🗣 跟读`
 * shadowing (listen → countdown pause of 1.2 × the slice → listen again).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CharSpan, FollowUpMessage, SentenceExplanation } from '@kotori/core';
import { useHost } from '../../host/HostContext';
import { useT, type Translate } from '../../i18n';
import { useBreakdownStore, type BubbleCropPreview } from '../../stores/breakdown';
import { useSettingsStore } from '../../stores/settings';
import { vocabForChunk } from '../../lib/explanation';
import { speakJapanese } from '../../lib/tts';
import { AssistantAvatar } from '../AssistantAvatar';
import { Button } from '../m3/Button';
import { cx } from '../m3/cx';
import { IconButton } from '../m3/IconButton';
import { LinearProgress } from '../m3/Progress';
import { Tabs } from '../m3/Tabs';
import { ChunkCard } from './ChunkCard';
import { FollowUpThread } from './FollowUpThread';
import { GrammarList } from './GrammarList';
import { inferWordSpanAt, RubyText } from './RubyText';
import { useBreakdownSelection } from './useBreakdownSelection';
import { useVocabEnrichment, VocabList } from './VocabList';
import './breakdown.css';

/**
 * Audio slice replay as registered by the player. The store types it as
 * `(startMs, endMs) => void`; the player's handler additionally accepts an
 * optional one-shot playback `rate` (restored when the slice ends).
 */
export type AudioSliceReplay = (startMs: number, endMs: number, rate?: number) => void;

/** Playback rate of the `🐢` slow replay pill. */
export const SLOW_REPLAY_RATE = 0.75;
/** Shadowing pause = slice duration × this factor. */
export const SHADOW_PAUSE_FACTOR = 1.2;
/** Seek padding the player adds around a replayed slice (≈ 80 ms + 120 ms). */
const SLICE_PADDING_MS = 300;

type ShadowPhase = 'idle' | 'listen' | 'speak' | 'compare';

/** Nearest scrollable ancestor element (the sheet body), if any. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | undefined {
  let cur = el?.parentElement ?? null;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return cur;
    cur = cur.parentElement;
  }
  return undefined;
}

export interface AiBreakdownPanelProps {
  readonly explanation: SentenceExplanation;
  readonly focusCharIndex: number | undefined;
  readonly onFocusChange: (charIndex: number) => void;
  readonly onFollowUp?: (question: string) => void;
  readonly thread?: readonly FollowUpMessage[];
  readonly streamingText?: string | undefined;
  readonly followUpPending?: boolean;
  readonly onRegenerate?: () => void;
  /** Replay the source audio slice (subtitles), optionally at a one-shot `rate`. */
  readonly onReplayAudio?: ((rate?: number) => void) | undefined;
  /** Duration of the source audio slice — enables `🗣 跟读` shadowing. */
  readonly audioDurationMs?: number | undefined;
  readonly bubblePreview?: BubbleCropPreview | undefined;
  readonly t?: Translate;
  readonly className?: string | undefined;
}

type Section = 'chunks' | 'vocab' | 'grammar';

function BubbleCropHeader({ preview }: { readonly preview: BubbleCropPreview }) {
  const [expanded, setExpanded] = useState(false);
  const pw = Math.max(1, preview.pageWidth || 800);
  const ph = Math.max(1, preview.pageHeight || 1200);
  const bw = Math.max(24, preview.rect.right - preview.rect.left);
  const bh = Math.max(24, preview.rect.bottom - preview.rect.top);
  const padX = Math.round(bw * (expanded ? 0.55 : 0.25));
  const padY = Math.round(bh * (expanded ? 0.55 : 0.25));
  const vx = Math.max(0, preview.rect.left - padX);
  const vy = Math.max(0, preview.rect.top - padY);
  const vw = Math.min(pw - vx, bw + padX * 2);
  const vh = Math.min(ph - vy, bh + padY * 2);

  return (
    <div
      className={cx('k-breakdown__bubble-crop', expanded && 'is-expanded')}
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? '点击收起原图裁切' : '点击放大查看气泡上下文'}
      data-testid="breakdown-bubble-crop"
    >
      <svg
        className="k-breakdown__bubble-crop-svg"
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <image href={preview.imageUrl} width={pw} height={ph} />
        <rect
          x={preview.rect.left}
          y={preview.rect.top}
          width={bw}
          height={bh}
          rx={4}
          fill="none"
          stroke="var(--md-sys-color-primary)"
          strokeWidth={Math.max(2, Math.round(Math.min(pw, ph) * 0.003))}
        />
      </svg>
      <span className="k-breakdown__bubble-crop-hint">
        {expanded ? '🔍 原图上下文（点击收起）' : '🖼️ 原漫气泡裁切（点击展开）'}
      </span>
    </div>
  );
}

export function AiBreakdownPanel({
  explanation,
  focusCharIndex,
  onFocusChange,
  onFollowUp,
  thread = [],
  streamingText,
  followUpPending = false,
  onRegenerate,
  onReplayAudio,
  audioDurationMs,
  bubblePreview,
  t: tProp,
  className,
}: AiBreakdownPanelProps) {
  const tHook = useT();
  const t = tProp ?? tHook;
  const sel = useBreakdownSelection(explanation, focusCharIndex, onFocusChange);
  const enrichments = useVocabEnrichment(explanation.vocab);
  const effectiveFocusSpan = useMemo<CharSpan | undefined>(() => {
    if (focusCharIndex === undefined) return undefined;
    return sel.focusWordSpan ?? inferWordSpanAt(explanation.sentence, focusCharIndex, explanation.ruby, 0);
  }, [focusCharIndex, sel.focusWordSpan, explanation.sentence, explanation.ruby]);
  const [section, setSection] = useState<Section>('chunks');
  const persona = useSettingsStore((s) => s.settings.ai.persona);
  const personaName = persona?.name?.trim();
  const copy = useCallback(() => void navigator.clipboard?.writeText(explanation.sentence).catch(() => {}), [explanation.sentence]);
  const speak = useCallback(() => void speakJapanese(explanation.sentence), [explanation.sentence]);

  // Open at the top (sticky sentence + translation + chunk 1) unless a later
  // chunk is focused — that card then scrolls itself into view.
  const rootRef = useRef<HTMLDivElement>(null);
  const activeChunkIndexRef = useRef(sel.activeChunkIndex);
  activeChunkIndexRef.current = sel.activeChunkIndex;
  useLayoutEffect(() => {
    if (activeChunkIndexRef.current > 0) return;
    const scroller = scrollParentOf(rootRef.current);
    if (!scroller) return;
    scroller.scrollTop = 0;
    // Late layout (fonts, ruby, restored follow-up thread) must not move it either.
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => (scroller.scrollTop = 0)) : undefined;
    return () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
    };
  }, [explanation.id]);

  // 🗣 Shadowing: play slice → pause (slice × 1.2, countdown) → play slice again.
  const [shadowPhase, setShadowPhase] = useState<ShadowPhase>('idle');
  const [shadowLeft, setShadowLeft] = useState(0);
  const shadowTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearShadow = useCallback(() => {
    for (const id of shadowTimers.current) clearTimeout(id);
    shadowTimers.current = [];
  }, []);
  useEffect(() => clearShadow, [clearShadow]);
  useEffect(() => {
    clearShadow();
    setShadowPhase('idle');
  }, [explanation.id, clearShadow]);
  const canShadow = Boolean(onReplayAudio) && audioDurationMs !== undefined && audioDurationMs > 0;
  const toggleShadow = useCallback(() => {
    if (!onReplayAudio || !audioDurationMs || audioDurationMs <= 0) return;
    clearShadow();
    if (shadowPhase !== 'idle') {
      setShadowPhase('idle');
      return;
    }
    const later = (ms: number, fn: () => void): void => {
      shadowTimers.current.push(setTimeout(fn, ms));
    };
    const slice = audioDurationMs + SLICE_PADDING_MS;
    const pause = Math.round(audioDurationMs * SHADOW_PAUSE_FACTOR);
    const seconds = Math.max(1, Math.ceil(pause / 1000));
    onReplayAudio(1);
    setShadowPhase('listen');
    later(slice, () => {
      setShadowPhase('speak');
      setShadowLeft(seconds);
    });
    for (let k = 1; k < seconds; k++) later(slice + k * 1000, () => setShadowLeft(seconds - k));
    later(slice + pause, () => {
      onReplayAudio(1);
      setShadowPhase('compare');
    });
    later(slice + pause + slice, () => setShadowPhase('idle'));
  }, [onReplayAudio, audioDurationMs, shadowPhase, clearShadow]);
  const shadowLabel =
    shadowPhase === 'listen' ? '👂 听原声…' : shadowPhase === 'speak' ? `🎙 请跟读… ${shadowLeft}s` : shadowPhase === 'compare' ? '🔁 对比原声…' : '🗣 跟读';
  const omitted = (explanation.omitted ?? []).filter((o) => o.text.trim() !== '');
  const dialogueRelation = explanation.dialogueRelation?.trim();

  return (
    <div ref={rootRef} className={cx('k-breakdown', className)} data-testid="ai-breakdown-panel">
      {bubblePreview && <BubbleCropHeader preview={bubblePreview} />}
      {/* Direct child of the scroll content so `position: sticky` keeps it in view. */}
      <div className="k-breakdown__sentence" data-testid="breakdown-sentence">
        <RubyText
          text={explanation.sentence}
          segments={explanation.ruby}
          highlight={sel.highlightSpan}
          focusIndex={focusCharIndex}
          focusSpan={effectiveFocusSpan}
          onCharClick={sel.selectChar}
        />
      </div>
      <section className="k-breakdown__sentence-block">
        <div className="k-breakdown__meta">
          {explanation.register && <span className="k-tag">{t(`breakdown.register.${explanation.register}`)}</span>}
          {explanation.tone && <span className="k-tag k-tag--tone">{explanation.tone}</span>}
          <span className="k-breakdown__meta-spacer" />
          {onReplayAudio && (
            <button
              type="button"
              className="k-breakdown__action-pill"
              onClick={() => onReplayAudio()}
              title="重听该句原声片段"
              data-testid="breakdown-replay-audio"
            >
              🔊 原声
            </button>
          )}
          {onReplayAudio && (
            <button
              type="button"
              className="k-breakdown__action-pill"
              onClick={() => onReplayAudio(SLOW_REPLAY_RATE)}
              title="0.75× 慢放该句原声"
              data-testid="breakdown-slow-audio"
            >
              🐢 慢放
            </button>
          )}
          {canShadow && (
            <button
              type="button"
              className={cx('k-breakdown__action-pill', shadowPhase !== 'idle' && 'is-active', shadowPhase === 'speak' && 'is-speak')}
              onClick={toggleShadow}
              title="跟读：播放原声 → 停顿留给你跟读 → 再播一遍对比"
              aria-pressed={shadowPhase !== 'idle'}
              aria-live="polite"
              data-testid="breakdown-shadow-audio"
              data-phase={shadowPhase}
            >
              {shadowLabel}
            </button>
          )}
          {!onReplayAudio && (
            <button
              type="button"
              className="k-breakdown__action-pill"
              onClick={speak}
              title="日语语音朗读 (TTS)"
              data-testid="breakdown-tts-sentence"
            >
              🗣️ 朗读
            </button>
          )}
          <IconButton icon="file" size="small" label={t('breakdown.copy')} onClick={copy} />
          {onRegenerate && <IconButton icon="refresh" size="small" label={t('breakdown.regenerate')} onClick={onRegenerate} />}
        </div>
        <div className="k-breakdown__translation-row" data-testid="breakdown-translation-row">
          <AssistantAvatar persona={persona} className="k-breakdown__avatar" size={32} />
          <div className="k-breakdown__translation-body">
            {personaName && <span className="k-breakdown__persona-name">{personaName}</span>}
            <p className="k-breakdown__translation">{explanation.translation}</p>
            {omitted.length > 0 && (
              <div className="k-breakdown__omitted" data-testid="breakdown-omitted">
                {omitted.map((o, i) => (
                  <span key={`${o.text}-${i}`} className="k-breakdown__ghost-chip" lang="ja" title={o.role}>
                    （省略：{o.text}
                    {o.role ? <span className="k-breakdown__ghost-role"> · {o.role}</span> : null}）
                  </span>
                ))}
              </div>
            )}
            {explanation.literalTranslation && (
              <p className="k-breakdown__literal">
                <span className="k-muted">{t('breakdown.literal')}：</span>
                {explanation.literalTranslation}
              </p>
            )}
          </div>
        </div>
        {dialogueRelation && (
          <div className="k-breakdown__relation" data-testid="breakdown-dialogue-relation">
            <span className="k-breakdown__cultural-icon" aria-hidden="true">
              🔗
            </span>
            <div className="k-breakdown__cultural-body">
              <strong className="k-breakdown__cultural-label">句间关系与语体</strong>
              <p className="k-breakdown__cultural-text">{dialogueRelation}</p>
            </div>
          </div>
        )}
        {explanation.degraded && (
          <div className="k-breakdown__degraded" role="status" data-testid="breakdown-degraded">
            <span>部分词块未通过原文对齐校验，已自动过滤</span>
            {onRegenerate && (
              <button type="button" className="k-breakdown__action-pill" onClick={onRegenerate} data-testid="breakdown-degraded-regenerate">
                重新生成
              </button>
            )}
          </div>
        )}
        {explanation.culturalNote && (
          <div className="k-breakdown__cultural-note" data-testid="breakdown-cultural-note">
            <span className="k-breakdown__cultural-icon" aria-hidden="true">💡</span>
            <div className="k-breakdown__cultural-body">
              <strong className="k-breakdown__cultural-label">文化与语境小贴士</strong>
              <p className="k-breakdown__cultural-text">{explanation.culturalNote}</p>
            </div>
          </div>
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
                enrichments={i === sel.activeChunkIndex ? enrichments : undefined}
                focusedVocabId={i === sel.activeChunkIndex ? sel.vocabAtFocus?.id : undefined}
                onSelect={sel.selectChunk}
                onSelectChar={sel.selectChar}
                t={t}
              />
            ))}
          </div>
        )}
        {section === 'vocab' && (
          <VocabList
            vocab={explanation.vocab}
            linkedIds={sel.linkedVocabIds}
            focusedVocabId={sel.vocabAtFocus?.id}
            enrichments={enrichments}
            onSelect={sel.selectChar}
            t={t}
          />
        )}
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
export function BreakdownSkeleton({
  sentence,
  focusCharIndex,
  onCharClick,
  t,
}: {
  readonly sentence: string;
  readonly focusCharIndex?: number | undefined;
  readonly onCharClick?: ((charIndex: number) => void) | undefined;
  readonly t: Translate;
}) {
  const focusSpan = useMemo<CharSpan | undefined>(
    () => (focusCharIndex !== undefined ? inferWordSpanAt(sentence, focusCharIndex) : undefined),
    [sentence, focusCharIndex],
  );
  return (
    <div className="k-breakdown is-loading" data-testid="breakdown-loading" aria-busy="true">
      <div className="k-breakdown__sentence">
        <RubyText text={sentence} focusIndex={focusCharIndex} focusSpan={focusSpan} onCharClick={onCharClick} />
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
  const bubblePreview = useBreakdownStore((s) => s.bubblePreview);
  const audioReplayHandler = useBreakdownStore((s) => s.audioReplayHandler);

  const onFollowUp = useCallback((q: string) => void askFollowUp(host, q), [askFollowUp, host]);
  const onRegenerate = useCallback(() => void retry(host), [retry, host]);
  const subtitleSource = request?.source.kind === 'subtitle' ? request.source : undefined;
  const onReplayAudio =
    subtitleSource && audioReplayHandler
      ? (rate?: number) => {
          const replay = audioReplayHandler as AudioSliceReplay;
          if (rate === undefined) replay(subtitleSource.startMs, subtitleSource.endMs);
          else replay(subtitleSource.startMs, subtitleSource.endMs, rate);
        }
      : undefined;
  const audioDurationMs = subtitleSource ? Math.max(0, subtitleSource.endMs - subtitleSource.startMs) : undefined;

  if (status === 'loading' && request)
    return <BreakdownSkeleton sentence={request.sentence} focusCharIndex={focusCharIndex} onCharClick={setFocus} t={t} />;
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
        onReplayAudio={onReplayAudio}
        audioDurationMs={audioDurationMs}
        bubblePreview={request?.source.kind === 'manga' ? bubblePreview : undefined}
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
