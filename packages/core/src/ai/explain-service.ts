/**
 * Explain service: implements the `AiApi` semantics (minus host plumbing) on
 * top of a `GeminiClient` and a host-provided `ExplanationCache`.
 */
import type {
  AiApi,
  AiCallOptions,
  AiSettings,
  ExplainRequest,
  FollowUpDelta,
  FollowUpMessage,
  FollowUpRequest,
  Id,
  MangaBubbleOcrRequest,
  MangaBubbleOcrResult,
  MangaPageGuideRequest,
  MangaPageGuideResult,
  SentenceExplanation,
  TokenUsage,
} from '../types';
import { KotoriError } from '../util/errors';
import { explanationCacheKey } from './cache-key';
import { BATCH_EXPLAIN_RESPONSE_SCHEMA, EXPLAIN_RESPONSE_SCHEMA, RawBatchExplanationSchema, RawExplanationSchema } from './explain-schema';
import { toSentenceExplanation } from './explanation';
import type { GeminiClient, GeminiRequest } from './gemini-client';
import { buildBatchExplainPrompt, buildExplainPrompt, buildFollowUpPrompt, PROMPT_VERSION } from './prompts';
import { generateStructured } from './structured';
import { ocrBubble as visionOcrBubble, pageGuide as visionPageGuide } from './vision';

/** Host-provided persistence for explanations and follow-up threads. */
export interface ExplanationCache {
  get(id: Id): Promise<SentenceExplanation | undefined>;
  put(explanation: SentenceExplanation): Promise<void>;
  getThread(explanationId: Id): Promise<readonly FollowUpMessage[]>;
  appendThread(explanationId: Id, message: FollowUpMessage): Promise<void>;
  clear(): Promise<{ readonly removed: number }>;
}

/** `AiApi` with streaming and batch explain always available. */
export interface ExplainService extends AiApi {
  explainBatch(requests: readonly ExplainRequest[], options?: AiCallOptions): Promise<readonly SentenceExplanation[]>;
  followUpStream(request: FollowUpRequest, onDelta: (delta: FollowUpDelta) => void, options?: AiCallOptions): Promise<FollowUpMessage>;
}

export interface ExplainServiceDeps {
  /** A client, or a factory called with the current settings for every call (settings may change). */
  readonly client: GeminiClient | ((settings: AiSettings) => GeminiClient);
  readonly cache: ExplanationCache;
  readonly settings: () => AiSettings;
  readonly now?: () => number;
  /** Message id factory (default: time + counter + random). */
  readonly newId?: (prefix: string) => string;
}

/** Throw `cancelled` when the signal is aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KotoriError('cancelled', 'Request cancelled');
}

/** Map AbortError-like failures to `cancelled` when the caller aborted. */
function normaliseError(e: unknown, signal: AbortSignal | undefined): KotoriError {
  if (signal?.aborted) return e instanceof KotoriError && e.code === 'cancelled' ? e : new KotoriError('cancelled', 'Request cancelled');
  return KotoriError.wrap(e);
}

/** Simple in-memory `ExplanationCache` (tests, mock host, cache-less hosts). */
export function createMemoryExplanationCache(): ExplanationCache {
  const explanations = new Map<Id, SentenceExplanation>();
  const threads = new Map<Id, FollowUpMessage[]>();
  return {
    async get(id) {
      return explanations.get(id);
    },
    async put(expl) {
      explanations.set(expl.id, expl);
    },
    async getThread(id) {
      return [...(threads.get(id) ?? [])];
    },
    async appendThread(id, msg) {
      const list = threads.get(id) ?? [];
      list.push(msg);
      threads.set(id, list);
    },
    async clear() {
      const removed = explanations.size;
      explanations.clear();
      threads.clear();
      return { removed };
    },
  };
}

/**
 * Create the explain service. Flow for `explain`: cache lookup → prompt →
 * client (JSON schema) → zod validation (one retry with a JSON nudge) →
 * alignment → cache put. Aborted calls reject with `cancelled` and never
 * write the cache or threads.
 */
export function createExplainService(deps: ExplainServiceDeps): ExplainService {
  const now = deps.now ?? (() => Date.now());
  let counter = 0;
  const newId =
    deps.newId ??
    ((prefix: string) => `${prefix}_${now().toString(36)}_${(counter++).toString(36)}_${Math.floor(Math.random() * 0x100000).toString(36)}`);
  const clientFor = (settings: AiSettings): GeminiClient => (typeof deps.client === 'function' ? deps.client(settings) : deps.client);

  /** Cache key for a request under the current settings. */
  const keyFor = (req: Pick<ExplainRequest, 'sentence' | 'targetLanguage'>, settings: AiSettings): Promise<string> =>
    explanationCacheKey({ sentence: req.sentence, targetLanguage: req.targetLanguage, model: settings.explainModel, promptVersion: PROMPT_VERSION });

  /** Common generation knobs from settings. */
  const knobs = (settings: AiSettings): Pick<GeminiRequest, 'temperature' | 'thinkingBudget' | 'timeoutMs'> => ({
    temperature: settings.temperature,
    timeoutMs: settings.timeoutMs,
    ...(settings.thinkingBudget !== undefined ? { thinkingBudget: settings.thinkingBudget } : {}),
  });

  /** Core explain implementation shared by `explain` and vision `explain: true`. */
  async function explain(request: ExplainRequest, options?: AiCallOptions): Promise<SentenceExplanation> {
    const signal = options?.signal;
    try {
      throwIfAborted(signal);
      if (!request.sentence.trim()) throw new KotoriError('invalid-argument', 'Cannot explain an empty sentence');
      const settings = deps.settings();
      const normalized: ExplainRequest = { ...request, targetLanguage: request.targetLanguage ?? settings.targetLanguage ?? 'zh-CN' };
      const id = await keyFor(normalized, settings);
      if (!normalized.force && settings.cacheEnabled) {
        const cached = await deps.cache.get(id);
        if (cached) return { ...cached, fromCache: true };
      }
      throwIfAborted(signal);
      const prompt = buildExplainPrompt(normalized);
      const res = await generateStructured(
        clientFor(settings),
        { model: settings.explainModel, ...prompt, responseSchema: EXPLAIN_RESPONSE_SCHEMA, ...knobs(settings) },
        RawExplanationSchema,
        signal,
      );
      throwIfAborted(signal);
      const expl = toSentenceExplanation(res.value, normalized, { id, model: settings.explainModel, usage: res.usage, now: now() });
      if (settings.cacheEnabled) await deps.cache.put(expl);
      return expl;
    } catch (e) {
      throw normaliseError(e, signal);
    }
  }

  /** Batch explain up to N sentences in a single structured LLM request and cache each result individually. */
  async function explainBatch(requests: readonly ExplainRequest[], options?: AiCallOptions): Promise<readonly SentenceExplanation[]> {
    const signal = options?.signal;
    try {
      throwIfAborted(signal);
      if (requests.length === 0) return [];
      const settings = deps.settings();
      const normalizedList: ExplainRequest[] = requests.map((r) => ({
        ...r,
        targetLanguage: r.targetLanguage ?? settings.targetLanguage ?? 'zh-CN',
      }));
      const ids = await Promise.all(normalizedList.map((r) => keyFor(r, settings)));
      const results: Array<SentenceExplanation | undefined> = new Array(normalizedList.length);
      const uncachedIndices: number[] = [];

      for (let i = 0; i < normalizedList.length; i++) {
        const req = normalizedList[i]!;
        const id = ids[i]!;
        if (!req.force && settings.cacheEnabled) {
          const cached = await deps.cache.get(id);
          if (cached) {
            results[i] = { ...cached, fromCache: true };
            continue;
          }
        }
        if (req.sentence.trim()) {
          uncachedIndices.push(i);
        }
      }

      if (uncachedIndices.length === 0) {
        return results.filter((x): x is SentenceExplanation => x !== undefined);
      }
      if (uncachedIndices.length === 1) {
        const idx = uncachedIndices[0]!;
        results[idx] = await explain(normalizedList[idx]!, options);
        return results.filter((x): x is SentenceExplanation => x !== undefined);
      }

      throwIfAborted(signal);
      const uncachedReqs = uncachedIndices.map((idx) => normalizedList[idx]!);
      const prompt = buildBatchExplainPrompt(uncachedReqs);
      const commonKnobs = knobs(settings);
      const res = await generateStructured(
        clientFor(settings),
        {
          model: settings.explainModel,
          ...prompt,
          responseSchema: BATCH_EXPLAIN_RESPONSE_SCHEMA,
          ...commonKnobs,
          timeoutMs: Math.max(commonKnobs.timeoutMs ?? 30_000, 60_000),
        },
        RawBatchExplanationSchema,
        signal,
      );
      throwIfAborted(signal);

      const items = res.value.items;
      const count = Math.min(items.length, uncachedIndices.length);
      for (let k = 0; k < count; k++) {
        const origIdx = uncachedIndices[k]!;
        const req = normalizedList[origIdx]!;
        const id = ids[origIdx]!;
        const expl = toSentenceExplanation(items[k]!, req, { id, model: settings.explainModel, usage: res.usage, now: now() });
        if (settings.cacheEnabled) await deps.cache.put(expl);
        results[origIdx] = expl;
      }

      // If the model returned fewer items than requested, fill any remaining slots sequentially
      for (let k = count; k < uncachedIndices.length; k++) {
        const origIdx = uncachedIndices[k]!;
        results[origIdx] = await explain(normalizedList[origIdx]!, options);
      }

      return results.filter((x): x is SentenceExplanation => x !== undefined);
    } catch (e) {
      throw normaliseError(e, signal);
    }
  }

  /** Resolve the explanation a follow-up refers to (`not-found` if none). */
  async function resolveExplanation(request: FollowUpRequest): Promise<SentenceExplanation> {
    if (request.explanation) return request.explanation;
    const cached = await deps.cache.get(request.explanationId);
    if (!cached) throw new KotoriError('not-found', `Explanation ${request.explanationId} not found`);
    return cached;
  }

  /** Shared follow-up implementation; streams when `onDelta` is given. */
  async function followUpImpl(request: FollowUpRequest, onDelta: ((d: FollowUpDelta) => void) | undefined, options?: AiCallOptions): Promise<FollowUpMessage> {
    const signal = options?.signal;
    try {
      throwIfAborted(signal);
      if (!request.question.trim()) throw new KotoriError('invalid-argument', 'Follow-up question is empty');
      const settings = deps.settings();
      const expl = await resolveExplanation(request);
      const history = request.history ?? (await deps.cache.getThread(expl.id));
      const targetLanguage = request.targetLanguage ?? expl.targetLanguage ?? settings.targetLanguage ?? 'zh-CN';
      const userMsg: FollowUpMessage = { id: newId('m'), role: 'user', text: request.question, createdAt: now() };
      const prompt = buildFollowUpPrompt(expl, history, request.question, targetLanguage, settings.persona);
      const genReq: GeminiRequest = { model: settings.explainModel, ...prompt, ...knobs(settings), temperature: Math.max(settings.temperature, 0.4) };
      const client = clientFor(settings);
      const messageId = newId('m');
      const res = onDelta
        ? await client.generateStream(genReq, (textDelta) => onDelta({ messageId, textDelta, done: false }), signal)
        : await client.generate(genReq, signal);
      throwIfAborted(signal);
      const text = res.text.trim();
      if (!text) throw new KotoriError('ai-invalid-response', 'Model returned an empty answer');
      const modelMsg: { -readonly [K in keyof FollowUpMessage]: FollowUpMessage[K] } = { id: messageId, role: 'model', text, createdAt: now() };
      if (res.usage) modelMsg.usage = res.usage;
      await deps.cache.appendThread(expl.id, userMsg);
      await deps.cache.appendThread(expl.id, modelMsg);
      if (onDelta) {
        const done: { messageId: string; textDelta: string; done: boolean; usage?: TokenUsage } = { messageId, textDelta: '', done: true };
        if (res.usage) done.usage = res.usage;
        onDelta(done);
      }
      return modelMsg;
    } catch (e) {
      throw normaliseError(e, signal);
    }
  }

  return {
    explain,
    explainBatch,

    async getCachedExplanation(request) {
      const settings = deps.settings();
      if (!settings.cacheEnabled) return undefined;
      const normalized = { ...request, targetLanguage: request.targetLanguage ?? settings.targetLanguage ?? 'zh-CN' };
      const cached = await deps.cache.get(await keyFor(normalized, settings));
      return cached ? { ...cached, fromCache: true } : undefined;
    },

    followUp(request, options) {
      return followUpImpl(request, undefined, options);
    },

    followUpStream(request, onDelta, options) {
      return followUpImpl(request, onDelta, options);
    },

    async ocrBubble(request: MangaBubbleOcrRequest, options?: AiCallOptions): Promise<MangaBubbleOcrResult> {
      const signal = options?.signal;
      try {
        throwIfAborted(signal);
        const settings = deps.settings();
        const normalized: MangaBubbleOcrRequest = { ...request, targetLanguage: request.targetLanguage ?? settings.targetLanguage ?? 'zh-CN' };
        return await visionOcrBubble(clientFor(settings), normalized, {
          model: settings.visionModel,
          ...knobs(settings),
          ...(signal ? { signal } : {}),
          now,
          explain: (sentence, s) =>
            explain(
              { sentence, targetLanguage: normalized.targetLanguage, source: { kind: 'manga', volumeId: normalized.volumeId, pageIndex: normalized.pageIndex } },
              s ? { signal: s } : {},
            ),
        });
      } catch (e) {
        throw normaliseError(e, signal);
      }
    },

    async pageGuide(request: MangaPageGuideRequest, options?: AiCallOptions): Promise<MangaPageGuideResult> {
      const signal = options?.signal;
      try {
        throwIfAborted(signal);
        const settings = deps.settings();
        const normalized: MangaPageGuideRequest = { ...request, targetLanguage: request.targetLanguage ?? settings.targetLanguage ?? 'zh-CN' };
        return await visionPageGuide(clientFor(settings), normalized, { model: settings.visionModel, ...knobs(settings), ...(signal ? { signal } : {}), now });
      } catch (e) {
        throw normaliseError(e, signal);
      }
    },

    getThread(explanationId) {
      return deps.cache.getThread(explanationId);
    },

    clearCache() {
      return deps.cache.clear();
    },
  };
}
