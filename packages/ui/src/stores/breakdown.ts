/**
 * Breakdown store — implements the click → highlight contract (ARCHITECTURE §6.2).
 *
 * - `open()` with the sentence that is already shown only moves `focusCharIndex`
 *   (pure synchronous state ⇒ 0 ms, no host call).
 * - Otherwise: cache probe (`ai.getCachedExplanation`) → on miss `ai.explain`
 *   with an `AbortSignal`; any previous in-flight call is aborted and its
 *   `cancelled` rejection ignored. A monotonically increasing token guards
 *   against out-of-order resolutions.
 * - Follow-up thread is restored with `ai.getThread` and extended via
 *   `ai.followUpStream` (when `capabilities.streaming`) or `ai.followUp`.
 */
import { create } from 'zustand';
import type {
  ExplainRequest,
  ExplainSource,
  FollowUpMessage,
  KotoriErrorCode,
  MangaRect,
  PlatformHost,
  SentenceExplanation,
  TargetLanguage,
} from '@kotori/core';
import { useSettingsStore } from './settings';

export interface BubbleCropPreview {
  readonly imageUrl: string;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly rect: MangaRect;
}

export interface BreakdownOpenInput {
  readonly sentence: string;
  readonly source: ExplainSource;
  readonly focusCharIndex?: number | undefined;
  readonly contextBefore?: readonly string[] | undefined;
  readonly contextAfter?: readonly string[] | undefined;
  readonly sceneHint?: string | undefined;
  /** Who says the line (subtitle actor / manga guide speaker); forwarded to the prompt. */
  readonly speaker?: string | undefined;
  readonly force?: boolean | undefined;
  readonly bubblePreview?: BubbleCropPreview | undefined;
}

export interface BreakdownError {
  readonly code: KotoriErrorCode;
  readonly message: string;
}

export type BreakdownStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BreakdownState {
  readonly isOpen: boolean;
  readonly status: BreakdownStatus;
  readonly request: ExplainRequest | undefined;
  readonly explanation: SentenceExplanation | undefined;
  readonly focusCharIndex: number | undefined;
  readonly error: BreakdownError | undefined;
  readonly thread: readonly FollowUpMessage[];
  /** Partial model answer while a streaming follow-up is in flight. */
  readonly streamingText: string | undefined;
  readonly followUpPending: boolean;
  /** Number of `ai.explain` network calls issued (diagnostics + tests). */
  readonly explainCalls: number;
  /** Optional manga speech-bubble crop preview for the currently inspected block. */
  readonly bubblePreview: BubbleCropPreview | undefined;
  /** Optional anime player callback to replay a `[startMs, endMs]` audio slice. */
  readonly audioReplayHandler: ((startMs: number, endMs: number) => void) | undefined;

  open(host: PlatformHost, input: BreakdownOpenInput): Promise<void>;
  /** Show an already-computed explanation (e.g. from `ocrBubble({ explain: true })`). */
  show(explanation: SentenceExplanation, source: ExplainSource, focusCharIndex?: number, bubblePreview?: BubbleCropPreview): void;
  setFocus(charIndex: number | undefined): void;
  setAudioReplayHandler(handler: ((startMs: number, endMs: number) => void) | undefined): void;
  retry(host: PlatformHost): Promise<void>;
  askFollowUp(host: PlatformHost, question: string): Promise<void>;
  setOpen(open: boolean): void;
  close(): void;
  reset(): void;
}

let inflight: AbortController | undefined;
let token = 0;

const errorCode = (e: unknown): KotoriErrorCode => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (code as KotoriErrorCode) : 'internal';
};
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const targetLanguage = (): TargetLanguage => useSettingsStore.getState().settings.ai.targetLanguage;

function buildRequest(input: BreakdownOpenInput): ExplainRequest {
  return {
    sentence: input.sentence,
    source: input.source,
    targetLanguage: targetLanguage(),
    ...(input.focusCharIndex !== undefined ? { focusCharIndex: input.focusCharIndex } : {}),
    ...(input.contextBefore ? { contextBefore: input.contextBefore } : {}),
    ...(input.contextAfter ? { contextAfter: input.contextAfter } : {}),
    ...(input.sceneHint ? { sceneHint: input.sceneHint } : {}),
    ...(input.speaker ? { speaker: input.speaker } : {}),
    ...(input.force ? { force: true } : {}),
  };
}

const initial = {
  isOpen: false,
  status: 'idle' as BreakdownStatus,
  thread: [] as readonly FollowUpMessage[],
  followUpPending: false,
  explainCalls: 0,
  request: undefined as ExplainRequest | undefined,
  explanation: undefined as SentenceExplanation | undefined,
  focusCharIndex: undefined as number | undefined,
  error: undefined as BreakdownError | undefined,
  streamingText: undefined as string | undefined,
  bubblePreview: undefined as BubbleCropPreview | undefined,
  audioReplayHandler: undefined as ((startMs: number, endMs: number) => void) | undefined,
};

export const useBreakdownStore = create<BreakdownState>()((set, get) => ({
  ...initial,

  async open(host, input) {
    const current = get();
    const sameSentence =
      !input.force &&
      current.request?.sentence === input.sentence &&
      current.request.targetLanguage === targetLanguage() &&
      (current.status === 'ready' || current.status === 'loading');
    if (sameSentence) {
      // Same sentence ⇒ pure state update: 0 latency, no network.
      set({
        isOpen: true,
        focusCharIndex: input.focusCharIndex,
        request: { ...current.request!, source: input.source },
        ...(input.bubblePreview !== undefined ? { bubblePreview: input.bubblePreview } : {}),
      });
      return;
    }

    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    const my = ++token;
    const request = buildRequest(input);
    set({
      isOpen: true,
      status: 'loading',
      request,
      explanation: undefined,
      error: undefined,
      focusCharIndex: input.focusCharIndex,
      thread: [],
      streamingText: undefined,
      followUpPending: false,
      bubblePreview: input.bubblePreview,
    });

    try {
      let explanation = input.force ? undefined : await host.ai.getCachedExplanation(request);
      if (my !== token) return;
      if (!explanation) {
        set((s) => ({ explainCalls: s.explainCalls + 1 }));
        explanation = await host.ai.explain(request, { signal: controller.signal });
      }
      if (my !== token) return;
      set({ status: 'ready', explanation });
      const thread = await host.ai.getThread(explanation.id).catch(() => [] as readonly FollowUpMessage[]);
      if (my === token) set({ thread });
    } catch (e) {
      if (my !== token || errorCode(e) === 'cancelled' || controller.signal.aborted) return;
      set({ status: 'error', error: { code: errorCode(e), message: errorMessage(e) } });
    } finally {
      if (inflight === controller) inflight = undefined;
    }
  },

  show(explanation, source, focusCharIndex, bubblePreview) {
    inflight?.abort();
    token++;
    set({
      isOpen: true,
      status: 'ready',
      explanation,
      request: { sentence: explanation.sentence, source, targetLanguage: explanation.targetLanguage },
      focusCharIndex,
      error: undefined,
      thread: [],
      streamingText: undefined,
      followUpPending: false,
      bubblePreview,
    });
  },

  setFocus(charIndex) {
    set({ focusCharIndex: charIndex });
  },

  setAudioReplayHandler(audioReplayHandler) {
    set({ audioReplayHandler });
  },

  async retry(host) {
    const req = get().request;
    if (!req) return;
    await get().open(host, {
      sentence: req.sentence,
      source: req.source,
      force: true,
      focusCharIndex: get().focusCharIndex,
      contextBefore: req.contextBefore,
      contextAfter: req.contextAfter,
      sceneHint: req.sceneHint,
      bubblePreview: get().bubblePreview,
    });
  },

  async askFollowUp(host, question) {
    const { explanation, thread } = get();
    const q = question.trim();
    if (!explanation || !q || get().followUpPending) return;
    const userMessage: FollowUpMessage = { id: `local-${Date.now()}`, role: 'user', text: q, createdAt: Date.now() };
    const explanationId = explanation.id;
    set({ thread: [...thread, userMessage], followUpPending: true, streamingText: '' });
    const request = { explanationId, explanation, history: thread, question: q, targetLanguage: targetLanguage() };
    try {
      const stream = host.info.capabilities.streaming ? host.ai.followUpStream?.bind(host.ai) : undefined;
      const answer = stream
        ? await stream(request, (delta) => {
            if (get().explanation?.id === explanationId) set((s) => ({ streamingText: (s.streamingText ?? '') + delta.textDelta }));
          })
        : await host.ai.followUp(request);
      if (get().explanation?.id !== explanationId) return;
      set((s) => ({ thread: [...s.thread, answer], followUpPending: false, streamingText: undefined }));
    } catch (e) {
      if (get().explanation?.id !== explanationId) return;
      const failure: FollowUpMessage = { id: `err-${Date.now()}`, role: 'model', text: `⚠️ ${errorMessage(e)}`, createdAt: Date.now() };
      set((s) => ({ thread: [...s.thread, failure], followUpPending: false, streamingText: undefined }));
    }
  },

  setOpen(isOpen) {
    set({ isOpen });
  },

  close() {
    set({ isOpen: false });
  },

  reset() {
    inflight?.abort();
    inflight = undefined;
    token++;
    set({ ...initial });
  },
}));
