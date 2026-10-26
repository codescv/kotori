/**
 * REST-only Gemini client for both the Gemini Developer API (API key) and
 * Vertex AI (Bearer token / Express API key). No SDK: identical code runs in
 * Node 22+ and in the Android WebView.
 */
import type { AiConnectionTestResult, AiSettings, KotoriErrorCode, TokenUsage, VertexAiProvider } from '../types';
import { KotoriError } from '../util/errors';
import { resolveAccessTokenProvider } from './credentials';

/** One content part (text or inline image). */
export type GeminiPart = { readonly text: string } | { readonly inlineData: { readonly mimeType: string; readonly data: string } };

export interface GeminiContent {
  readonly role: 'user' | 'model';
  readonly parts: readonly GeminiPart[];
}

/** Provider-neutral request accepted by `GeminiClient`. */
export interface GeminiRequest {
  readonly model: string;
  readonly contents: readonly GeminiContent[];
  readonly systemInstruction?: string;
  /** e.g. `application/json` for structured output. */
  readonly responseMimeType?: string;
  /** Gemini OpenAPI-subset schema (used with `responseMimeType: application/json`). */
  readonly responseSchema?: unknown;
  readonly temperature?: number;
  /** `0` disables thinking on 2.5 Flash; `undefined` = model default. */
  readonly thinkingBudget?: number;
  readonly maxOutputTokens?: number;
  /** Per-request timeout override (defaults to `AiSettings.timeoutMs`). */
  readonly timeoutMs?: number;
}

export interface GeminiResponse {
  /** Concatenated non-thought text of the first candidate. */
  readonly text: string;
  readonly model: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
}

export interface GeminiClient {
  generate(request: GeminiRequest, signal?: AbortSignal): Promise<GeminiResponse>;
  /** Streams text deltas through `onText`; resolves with the full response. */
  generateStream(request: GeminiRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<GeminiResponse>;
}

export interface GeminiClientDeps {
  readonly fetch?: typeof fetch;
  /** Bearer token source; overrides the one derived from `VertexAuth` (required for `adc`). */
  readonly accessTokenProvider?: () => Promise<string>;
  readonly now?: () => number;
}

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const SAFETY_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/** Default Vertex host for a location (`global` → no regional prefix). */
export function vertexBaseUrl(provider: Pick<VertexAiProvider, 'location' | 'baseUrl'>): string {
  if (provider.baseUrl) return provider.baseUrl.replace(/\/+$/, '');
  const loc = provider.location.trim() || 'global';
  return loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`;
}

/**
 * Build the endpoint URL for `generateContent` / `streamGenerateContent`.
 * Secrets that travel in the query string (Vertex Express key) are included;
 * header-borne secrets are added by the client.
 */
export function buildGeminiEndpoint(settings: Pick<AiSettings, 'provider'>, model: string, stream: boolean): string {
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const p = settings.provider;
  const m = encodeURIComponent(model);
  const sse = stream ? 'alt=sse' : '';
  if (p.provider === 'gemini-api') {
    const base = (p.baseUrl ?? DEFAULT_GEMINI_BASE).replace(/\/+$/, '');
    return `${base}/${p.apiVersion ?? 'v1beta'}/models/${m}:${method}${sse ? `?${sse}` : ''}`;
  }
  const base = vertexBaseUrl(p);
  if (p.auth.kind === 'express-api-key') {
    const q = [sse, `key=${encodeURIComponent(p.auth.apiKey)}`].filter(Boolean).join('&');
    return `${base}/v1/publishers/google/models/${m}:${method}?${q}`;
  }
  if (!p.project) throw new KotoriError('invalid-argument', 'Vertex AI requires a project id');
  const loc = encodeURIComponent(p.location.trim() || 'global');
  return `${base}/v1/projects/${encodeURIComponent(p.project)}/locations/${loc}/publishers/google/models/${m}:${method}${sse ? `?${sse}` : ''}`;
}

/** Convert a `GeminiRequest` into the REST JSON body. */
export function buildGeminiBody(request: GeminiRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};
  if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
  if (request.maxOutputTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxOutputTokens;
  if (request.responseMimeType !== undefined) generationConfig['responseMimeType'] = request.responseMimeType;
  if (request.responseSchema !== undefined) generationConfig['responseSchema'] = request.responseSchema;
  if (request.thinkingBudget !== undefined) generationConfig['thinkingConfig'] = { thinkingBudget: request.thinkingBudget };
  const body: Record<string, unknown> = { contents: request.contents };
  if (request.systemInstruction) body['systemInstruction'] = { parts: [{ text: request.systemInstruction }] };
  if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
  return body;
}

interface RawCandidate {
  content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  finishReason?: string;
}
interface RawGenerateResponse {
  candidates?: RawCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  modelVersion?: string;
}

/** Map `usageMetadata` to `TokenUsage` (thinking tokens count as output). */
function toUsage(raw: RawGenerateResponse['usageMetadata']): TokenUsage | undefined {
  if (!raw) return undefined;
  const usage: { promptTokens: number; outputTokens: number; cachedTokens?: number } = {
    promptTokens: raw.promptTokenCount ?? 0,
    outputTokens: (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0),
  };
  if (raw.cachedContentTokenCount !== undefined) usage.cachedTokens = raw.cachedContentTokenCount;
  return usage;
}

/** Text of the first candidate, skipping thought parts. */
function candidateText(raw: RawGenerateResponse): string {
  const parts = raw.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

/** Map an HTTP error status + body to a `KotoriErrorCode`. */
export function mapHttpErrorCode(status: number, bodyText: string): KotoriErrorCode {
  if (status === 401 || status === 403) return 'ai-auth';
  if (status === 429) return 'ai-quota';
  if (status === 400 && /API_KEY_INVALID|API key not valid|UNAUTHENTICATED/i.test(bodyText)) return 'ai-auth';
  if (status === 400) return 'invalid-argument';
  if (status === 404) return 'not-found';
  if (status === 408 || status === 504) return 'ai-timeout';
  return 'network';
}

/** Extract `error.message` from a Google API error body when present. */
function errorMessage(bodyText: string, status: number): string {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const first = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
    const msg = (first as { error?: { message?: unknown } } | undefined)?.error?.message;
    if (typeof msg === 'string' && msg) return msg;
  } catch {
    // not JSON
  }
  return bodyText.slice(0, 300) || `HTTP ${status}`;
}

/**
 * Validate a decoded response chunk: prompt blocks and safety stops become
 * `ai-safety` (only when no text was produced at all).
 */
function checkSafety(raw: RawGenerateResponse, accumulatedText: string): void {
  if (raw.promptFeedback?.blockReason) {
    throw new KotoriError('ai-safety', `Prompt blocked: ${raw.promptFeedback.blockReason}`, { details: { blockReason: raw.promptFeedback.blockReason } });
  }
  const reason = raw.candidates?.[0]?.finishReason;
  if (reason && SAFETY_REASONS.has(reason) && accumulatedText.length === 0) {
    throw new KotoriError('ai-safety', `Response blocked: ${reason}`, { details: { finishReason: reason } });
  }
}

/** Combined abort controller for caller signal + timeout. */
interface CallScope {
  readonly signal: AbortSignal;
  /** Translate a thrown value into the right `KotoriError` (cancelled / timeout / network). */
  mapError(e: unknown): KotoriError;
  dispose(): void;
}

/** Create a call scope linking the caller signal and a timeout timer. */
function createScope(callerSignal: AbortSignal | undefined, timeoutMs: number): CallScope {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('timeout'));
        }, timeoutMs)
      : undefined;
  return {
    signal: controller.signal,
    mapError(e: unknown): KotoriError {
      if (e instanceof KotoriError) return e;
      if (timedOut) return new KotoriError('ai-timeout', `Gemini request timed out after ${timeoutMs} ms`);
      if (callerSignal?.aborted || controller.signal.aborted) return new KotoriError('cancelled', 'Request cancelled');
      return new KotoriError('network', e instanceof Error ? e.message : String(e), { cause: e });
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Parse a Server-Sent-Events byte stream, invoking `onData` with each
 * `data:` payload (multi-line data joined with `\n`).
 */
export async function readSseStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const flushEvent = (): void => {
    if (dataLines.length > 0) onData(dataLines.join('\n'));
    dataLines = [];
  };
  const handleLine = (line: string): void => {
    if (line === '') return flushEvent();
    if (line.startsWith(':')) return;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
      // A trailing lone '\r' may be the first half of a CRLF split across chunks.
      if (nl === buffer.length - 1 && buffer.endsWith('\r')) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
      handleLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) for (const line of buffer.split(/\r\n|\n|\r/)) handleLine(line);
  flushEvent();
}

/**
 * Create a Gemini client bound to `settings`. Vertex bearer tokens come from
 * `deps.accessTokenProvider` or, failing that, from
 * `resolveAccessTokenProvider(settings.provider.auth)`.
 */
export function createGeminiClient(settings: AiSettings, deps: GeminiClientDeps = {}): GeminiClient {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const provider = settings.provider;
  let tokenProvider: (() => Promise<string>) | undefined;
  if (provider.provider === 'vertex-ai' && provider.auth.kind !== 'express-api-key') {
    tokenProvider =
      deps.accessTokenProvider ??
      resolveAccessTokenProvider(provider.auth, { fetch: doFetch, ...(deps.now ? { now: deps.now } : {}) });
  }

  /** Request headers for the configured provider. */
  async function headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (provider.provider === 'gemini-api') h['x-goog-api-key'] = provider.apiKey;
    else if (provider.auth.kind !== 'express-api-key') {
      if (!tokenProvider) throw new KotoriError('unsupported', `Vertex auth '${provider.auth.kind}' is not available on this host`);
      let token: string;
      try {
        token = await tokenProvider();
      } catch (e) {
        throw KotoriError.wrap(e, 'ai-auth');
      }
      h['authorization'] = `Bearer ${token}`;
    }
    return h;
  }

  /** POST the request; throws mapped errors for non-2xx responses. */
  async function post(request: GeminiRequest, stream: boolean, scope: CallScope): Promise<Response> {
    const url = buildGeminiEndpoint(settings, request.model, stream);
    const h = await headers();
    if (scope.signal.aborted) throw new KotoriError('cancelled', 'Request cancelled');
    const res = await doFetch(url, { method: 'POST', headers: h, body: JSON.stringify(buildGeminiBody(request)), signal: scope.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new KotoriError(mapHttpErrorCode(res.status, text), errorMessage(text, res.status), { details: { status: res.status } });
    }
    return res;
  }

  return {
    async generate(request, signal) {
      const scope = createScope(signal, request.timeoutMs ?? settings.timeoutMs);
      try {
        if (scope.signal.aborted) throw new KotoriError('cancelled', 'Request cancelled');
        const res = await post(request, false, scope);
        let raw: RawGenerateResponse;
        try {
          raw = (await res.json()) as RawGenerateResponse;
        } catch (e) {
          if (scope.signal.aborted) throw e;
          throw new KotoriError('ai-invalid-response', 'Gemini returned a non-JSON body');
        }
        const text = candidateText(raw);
        checkSafety(raw, text);
        if (!raw.candidates || raw.candidates.length === 0) throw new KotoriError('ai-invalid-response', 'Gemini returned no candidates');
        const out: { text: string; model: string; finishReason?: string; usage?: TokenUsage } = { text, model: raw.modelVersion ?? request.model };
        const finish = raw.candidates[0]?.finishReason;
        if (finish) out.finishReason = finish;
        const usage = toUsage(raw.usageMetadata);
        if (usage) out.usage = usage;
        return out;
      } catch (e) {
        throw scope.mapError(e);
      } finally {
        scope.dispose();
      }
    },

    async generateStream(request, onText, signal) {
      const scope = createScope(signal, request.timeoutMs ?? settings.timeoutMs);
      try {
        if (scope.signal.aborted) throw new KotoriError('cancelled', 'Request cancelled');
        const res = await post(request, true, scope);
        if (!res.body) throw new KotoriError('ai-invalid-response', 'Streaming response has no body');
        let text = '';
        let finishReason: string | undefined;
        let usage: TokenUsage | undefined;
        let modelVersion: string | undefined;
        let parseError: KotoriError | undefined;
        await readSseStream(res.body, (data) => {
          if (parseError) return;
          let raw: RawGenerateResponse;
          try {
            raw = JSON.parse(data) as RawGenerateResponse;
          } catch {
            parseError = new KotoriError('ai-invalid-response', 'Malformed streaming chunk');
            return;
          }
          checkSafety(raw, text);
          const delta = candidateText(raw);
          if (delta) {
            text += delta;
            onText(delta);
          }
          finishReason = raw.candidates?.[0]?.finishReason ?? finishReason;
          usage = toUsage(raw.usageMetadata) ?? usage;
          modelVersion = raw.modelVersion ?? modelVersion;
        });
        if (parseError) throw parseError;
        if (scope.signal.aborted) throw new KotoriError('cancelled', 'Request cancelled');
        const out: { text: string; model: string; finishReason?: string; usage?: TokenUsage } = { text, model: modelVersion ?? request.model };
        if (finishReason) out.finishReason = finishReason;
        if (usage) out.usage = usage;
        return out;
      } catch (e) {
        throw scope.mapError(e);
      } finally {
        scope.dispose();
      }
    },
  };
}

/**
 * Round-trip a tiny prompt through the configured provider (backs
 * `SettingsApi.testAi` on every host). Never throws: failures are reported in
 * the result.
 */
export async function testAiConnection(settings: AiSettings, deps: GeminiClientDeps = {}): Promise<AiConnectionTestResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  try {
    const client = createGeminiClient(settings, deps);
    const res = await client.generate({
      model: settings.explainModel,
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
      temperature: 0,
      ...(settings.thinkingBudget !== undefined ? { thinkingBudget: settings.thinkingBudget } : {}),
    });
    return { ok: true, model: res.model, latencyMs: now() - started, message: res.text.trim() || 'OK' };
  } catch (e) {
    const err = KotoriError.wrap(e);
    return { ok: false, model: settings.explainModel, latencyMs: now() - started, message: `${err.code}: ${err.message}` };
  }
}
