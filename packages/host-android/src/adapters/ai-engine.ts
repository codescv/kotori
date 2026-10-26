/**
 * AI engine factory — wires core's `createGeminiClient` (+ Vertex credentials
 * via `resolveAccessTokenProvider` when the host has ADC) into
 * `createExplainService`, which implements the whole `AiApi` (explain,
 * cache, follow-ups incl. streaming, `ocrBubble` / `pageGuide` vision with
 * `explain: true`, threads, `clearCache`), plus `testAi` via
 * `testAiConnection`.
 */
import type { AiConnectionTestResult, AiSettings } from '@kotori/core';
import {
  createExplainService,
  createGeminiClient,
  resolveAccessTokenProvider,
  testAiConnection,
  type ExplainService,
  type ExplanationCache,
  type GeminiClient,
} from './core';

export interface AiEngineDeps {
  /** Current AI settings (sync; hosts keep settings in memory). */
  readonly settings: () => AiSettings;
  readonly cache: ExplanationCache;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Host ADC token source (desktop only; Android leaves it undefined). */
  readonly adc?: () => Promise<string>;
}

export interface AiEngine extends ExplainService {
  testAi(settings?: AiSettings): Promise<AiConnectionTestResult>;
}

/** Client deps for a settings snapshot (core derives tokens for access-token / SA-JSON / express itself). */
function clientDeps(settings: AiSettings, deps: AiEngineDeps): { fetch: typeof fetch; now: () => number; accessTokenProvider?: () => Promise<string> } {
  const base = { fetch: deps.fetch, now: deps.now };
  if (deps.adc === undefined || settings.provider.provider !== 'vertex-ai' || settings.provider.auth.kind !== 'adc') return base;
  const accessTokenProvider = resolveAccessTokenProvider(settings.provider.auth, { adc: deps.adc, fetch: deps.fetch, now: deps.now });
  return accessTokenProvider === undefined ? base : { ...base, accessTokenProvider };
}

/** `AiApi` (always streaming-capable) + `testAi`. */
export function createAiEngine(deps: AiEngineDeps): AiEngine {
  // A factory, so provider/model changes in settings apply to the next call.
  const client = (settings: AiSettings): GeminiClient => createGeminiClient(settings, clientDeps(settings, deps));
  const service = createExplainService({ client, cache: deps.cache, settings: deps.settings, now: deps.now });
  return {
    ...service,
    testAi(settings) {
      const effective = settings ?? deps.settings();
      return testAiConnection(effective, clientDeps(effective, deps));
    },
  };
}
