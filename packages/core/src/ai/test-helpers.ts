/**
 * Shared helpers for `src/ai/*.test.ts` (not exported from the package).
 */
import type { AiSettings } from '../types';
import type { GeminiClient, GeminiRequest, GeminiResponse } from './gemini-client';

// Tests run under Node only; load node:fs through an untyped dynamic import
// (core's tsconfig has `types: []`, so no @types/node in scope).
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: 'utf8'): string };

/** Read a fixture under `packages/core/test-fixtures/ai/`. */
export function aiFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../test-fixtures/ai/${name}`, import.meta.url), 'utf8')) as T;
}

export const baseSettings: AiSettings = {
  provider: { provider: 'gemini-api', apiKey: 'test-key' },
  explainModel: 'gemini-2.5-flash',
  visionModel: 'gemini-2.5-flash',
  temperature: 0.2,
  targetLanguage: 'zh-CN',
  cacheEnabled: true,
  timeoutMs: 30_000,
};

/** Scripted fake client: each call pops the next responder. */
export function fakeClient(
  responders: Array<(req: GeminiRequest, signal?: AbortSignal) => Promise<Partial<GeminiResponse>> | Partial<GeminiResponse>>,
): GeminiClient & { calls: GeminiRequest[] } {
  const calls: GeminiRequest[] = [];
  const next = async (req: GeminiRequest, signal?: AbortSignal): Promise<GeminiResponse> => {
    calls.push(req);
    const r = responders.shift();
    if (!r) throw new Error('fakeClient: no more scripted responses');
    const out = await r(req, signal);
    return { text: '', model: req.model, ...out };
  };
  return {
    calls,
    generate: (req, signal) => next(req, signal),
    async generateStream(req, onText, signal) {
      const res = await next(req, signal);
      // Emit in 3 roughly equal pieces to exercise delta handling.
      const t = res.text;
      const step = Math.max(1, Math.ceil(t.length / 3));
      for (let i = 0; i < t.length; i += step) onText(t.slice(i, i + step));
      return res;
    },
  };
}

/** Build a `Response` carrying a Gemini `generateContent` JSON body. */
export function geminiJsonResponse(text: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
      modelVersion: 'gemini-2.5-flash-001',
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
