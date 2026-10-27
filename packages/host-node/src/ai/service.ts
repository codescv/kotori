/**
 * Desktop `AiApi`: core's explain service (Gemini REST, JSON schema, span
 * alignment, vision) wired to the SQLite explanation cache and the host's
 * credentials (ADC via google-auth-library on top of core's
 * access-token / service-account / express-key handling). A client is built
 * per call from the *current* settings, so provider changes apply instantly.
 */
import { createExplainService, createGeminiClient, resolveAccessTokenProvider, testAiConnection } from '@kotori/core';
import type {
  AiApi,
  AiConnectionTestResult,
  AiSettings,
  ExplainService,
  ExplanationCache,
  FollowUpMessage,
  GeminiClient,
  GeminiClientDeps,
  SentenceExplanation,
} from '@kotori/core';
import type { Repositories } from '../db/repositories';

export interface AiServiceDeps {
  readonly repos: Pick<Repositories, 'explanations' | 'threads'>;
  readonly settings: () => AiSettings;
  /** ADC token provider (desktop only). */
  readonly adc?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** `ExplanationCache` over SQLite (honours `cacheEnabled` for writes). */
export function createSqliteExplanationCache(repos: Pick<Repositories, 'explanations' | 'threads'>, settings: () => AiSettings): ExplanationCache {
  return {
    async get(id: string): Promise<SentenceExplanation | undefined> {
      return repos.explanations.get(id);
    },
    async put(expl: SentenceExplanation): Promise<void> {
      if (settings().cacheEnabled) repos.explanations.put(expl);
    },
    async getThread(id: string): Promise<readonly FollowUpMessage[]> {
      return repos.threads.list(id);
    },
    async appendThread(id: string, message: FollowUpMessage): Promise<void> {
      repos.threads.append(id, message);
    },
    async clear(): Promise<{ readonly removed: number }> {
      return { removed: repos.explanations.clear() };
    },
  };
}

export interface HostAiService extends ExplainService {
  /** `settings.testAi` implementation. */
  testConnection(settings: AiSettings): Promise<AiConnectionTestResult>;
}

export function createAiService(deps: AiServiceDeps): HostAiService {
  const cache = createSqliteExplanationCache(deps.repos, deps.settings);

  /** Client deps for the given settings (ADC is the only host-specific credential). */
  function clientDeps(settings: AiSettings): GeminiClientDeps {
    const provider = settings.provider;
    const accessTokenProvider =
      provider.provider === 'vertex-ai'
        ? resolveAccessTokenProvider(provider.auth, {
            ...(deps.adc ? { adc: deps.adc } : {}),
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            ...(deps.now ? { now: deps.now } : {}),
          })
        : undefined;
    return {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(accessTokenProvider ? { accessTokenProvider } : {}),
    };
  }

  const clientFor = (settings: AiSettings): GeminiClient => createGeminiClient(settings, clientDeps(settings));

  const service = createExplainService({
    client: clientFor,
    cache,
    settings: deps.settings,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const api: AiApi = service;
  return {
    ...service,
    explain: (request, options) => api.explain(request, options),
    explainBatch: (requests, options) => service.explainBatch!(requests, options),
    getCachedExplanation: (request) => api.getCachedExplanation(request),
    followUp: (request, options) => api.followUp(request, options),
    followUpStream: (request, onDelta, options) => service.followUpStream(request, onDelta, options),
    ocrBubble: (request, options) => api.ocrBubble(request, options),
    pageGuide: (request, options) => api.pageGuide(request, options),
    getThread: (id) => api.getThread(id),
    clearCache: () => api.clearCache(),
    testConnection: async (settings) => {
      try {
        return await testAiConnection(settings, clientDeps(settings));
      } catch (error) {
        // resolveAccessTokenProvider may throw synchronously (e.g. ADC missing).
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, model: settings.explainModel, latencyMs: 0, message };
      }
    },
  };
}
