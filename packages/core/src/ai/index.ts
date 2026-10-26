/**
 * @kotori/core/ai — Gemini Flash sentence breakdown engine.
 *
 * Owner: coder-1. Modules (see ARCHITECTURE.md §4.1):
 *   - gemini-client.ts   createGeminiClient(settings, deps): { generate, generateStream }
 *                        — REST `generateContent` for BOTH `gemini-api` (x-goog-api-key)
 *                        and `vertex-ai` (Bearer token / express key). No SDK. Honours AbortSignal.
 *                        testAiConnection(settings, deps) backs `SettingsApi.testAi`.
 *   - service-account.ts createServiceAccountTokenProvider(json, deps) — RS256 JWT via crypto.subtle
 *                        + OAuth token exchange (platform-neutral; Android too)
 *   - credentials.ts     resolveAccessTokenProvider(auth: VertexAuth, deps: { adc?, fetch?, now? })
 *   - explain-schema.ts  zod schema + Gemini `responseSchema` JSON for the raw model output
 *   - prompts.ts         PROMPT_VERSION, buildExplainPrompt(), buildFollowUpPrompt(),
 *                        buildBubbleOcrPrompt(), buildPageGuidePrompt()
 *   - span-align.ts      alignSpans(sentence, surfaces[]) → CharSpan[] + SpanAlignment[]
 *                        (deterministic, monotonic cursor, exact → fuzzy → unaligned)
 *   - ruby.ts            buildRuby(sentence, modelRuby[]) → RubySegment[] covering sentence
 *   - explanation.ts     toSentenceExplanation(raw, request, meta) (schema → types + alignment)
 *                        findChunkAt(expl, charIndex), findVocabAt(expl, charIndex), chunkIndexAt()
 *   - cache-key.ts       explanationCacheKey({ sentence, targetLanguage, model, promptVersion })
 *   - structured.ts      generateStructured(client, request, zodSchema) (validate + 1 retry)
 *   - explain-service.ts createExplainService({ client, cache, settings }): ExplainService
 *                        (implements AiApi semantics incl. AiCallOptions.signal and
 *                        FollowUpRequest.explanation fallback; hosts wrap it)
 *   - vision.ts          ocrBubble(), pageGuide() using the vision model
 */
export * from './gemini-client';
export * from './service-account';
export * from './credentials';
export * from './explain-schema';
export * from './prompts';
export * from './span-align';
export * from './ruby';
export * from './explanation';
export * from './cache-key';
export * from './structured';
export * from './explain-service';
export * from './vision';
