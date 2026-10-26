/**
 * Structured (JSON-schema) generation with validation and a single retry.
 */
import type { z } from 'zod';
import type { TokenUsage } from '../types';
import { KotoriError } from '../util/errors';
import { parseModelJson } from './explain-schema';
import type { GeminiClient, GeminiRequest } from './gemini-client';
import { INVALID_JSON_NUDGE } from './prompts';

export interface StructuredResult<T> {
  readonly value: T;
  readonly model: string;
  readonly usage?: TokenUsage;
}

/** Sum two usages (retry accounting). */
function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: { promptTokens: number; outputTokens: number; cachedTokens?: number } = {
    promptTokens: a.promptTokens + b.promptTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  if (a.cachedTokens !== undefined || b.cachedTokens !== undefined) out.cachedTokens = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
  return out;
}

/** Parse + validate model text; throws `ai-invalid-response` on failure. */
function validate<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  let json: unknown;
  try {
    json = parseModelJson(text);
  } catch {
    throw new KotoriError('ai-invalid-response', 'Model returned invalid JSON', { details: { sample: text.slice(0, 200) } });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new KotoriError('ai-invalid-response', `Model JSON does not match the schema: ${parsed.error.message.slice(0, 300)}`);
  }
  return parsed.data;
}

/**
 * Call `client.generate` with `responseMimeType: application/json`, validate
 * with `schema`, and retry once with a "return valid JSON" nudge when the
 * answer is invalid. Aborts propagate as `cancelled`.
 */
export async function generateStructured<S extends z.ZodType>(
  client: GeminiClient,
  request: GeminiRequest,
  schema: S,
  signal?: AbortSignal,
): Promise<StructuredResult<z.infer<S>>> {
  const req: GeminiRequest = { ...request, responseMimeType: 'application/json' };
  const first = await client.generate(req, signal);
  try {
    const value = validate(schema, first.text);
    return first.usage ? { value, model: first.model, usage: first.usage } : { value, model: first.model };
  } catch (e) {
    if (!(e instanceof KotoriError) || e.code !== 'ai-invalid-response') throw e;
  }
  if (signal?.aborted) throw new KotoriError('cancelled', 'Request cancelled');
  const retry: GeminiRequest = {
    ...req,
    contents: [...req.contents, { role: 'model', parts: [{ text: first.text || '{}' }] }, { role: 'user', parts: [{ text: INVALID_JSON_NUDGE }] }],
  };
  const second = await client.generate(retry, signal);
  const value = validate(schema, second.text);
  const usage = addUsage(first.usage, second.usage);
  return usage ? { value, model: second.model, usage } : { value, model: second.model };
}
