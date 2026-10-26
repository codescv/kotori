import { describe, expect, it, vi } from 'vitest';
import type { AiSettings } from '../types';
import { KotoriError } from '../util/errors';
import { buildGeminiBody, buildGeminiEndpoint, createGeminiClient, mapHttpErrorCode, readSseStream, testAiConnection, vertexBaseUrl } from './gemini-client';
import { baseSettings, geminiJsonResponse } from './test-helpers';

type FetchCall = { url: string; init: RequestInit };

/** Mock fetch recording calls and returning scripted responses. */
function mockFetch(...responses: Array<Response | ((url: string, init: RequestInit) => Promise<Response> | Response)>): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    return typeof r === 'function' ? r(url, init ?? {}) : r;
  }) as typeof fetch & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

const vertex = (auth: Extract<AiSettings['provider'], { provider: 'vertex-ai' }>['auth'], location = 'us-central1'): AiSettings => ({
  ...baseSettings,
  provider: { provider: 'vertex-ai', project: 'my-proj', location, auth },
});

const req = { model: 'gemini-2.5-flash', contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }] };

/** Build an SSE response from JSON chunks. */
function sseResponse(chunks: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\r\n\r\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('endpoints', () => {
  it('builds Gemini API and Vertex URLs', () => {
    expect(buildGeminiEndpoint(baseSettings, 'gemini-2.5-flash', false)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(buildGeminiEndpoint({ provider: { provider: 'gemini-api', apiKey: 'k', baseUrl: 'https://proxy/', apiVersion: 'v1' } }, 'm', true)).toBe('https://proxy/v1/models/m:streamGenerateContent?alt=sse');
    expect(buildGeminiEndpoint(vertex({ kind: 'adc' }), 'gemini-2.5-flash', false)).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    expect(buildGeminiEndpoint(vertex({ kind: 'adc' }, 'global'), 'm', true)).toBe('https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/m:streamGenerateContent?alt=sse');
    expect(buildGeminiEndpoint(vertex({ kind: 'express-api-key', apiKey: 'a b' }, 'global'), 'm', true)).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/m:streamGenerateContent?alt=sse&key=a%20b');
    expect(() => buildGeminiEndpoint({ provider: { provider: 'vertex-ai', location: 'us', auth: { kind: 'adc' } } }, 'm', false)).toThrow(KotoriError);
    expect(vertexBaseUrl({ location: 'x', baseUrl: 'https://b/' })).toBe('https://b');
  });

  it('builds the request body', () => {
    const body = buildGeminiBody({ ...req, systemInstruction: 'sys', temperature: 0.2, thinkingBudget: 0, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' }, maxOutputTokens: 5 });
    expect(body).toEqual({
      contents: req.contents,
      systemInstruction: { parts: [{ text: 'sys' }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 5, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' }, thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(buildGeminiBody(req)).toEqual({ contents: req.contents });
  });
});

describe('createGeminiClient.generate', () => {
  it('sends x-goog-api-key and parses text + usage (skipping thoughts)', async () => {
    const f = mockFetch(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Hello' }, { text: ' world' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 5, cachedContentTokenCount: 1 },
          modelVersion: 'gemini-2.5-flash-001',
        }),
      ),
    );
    const res = await createGeminiClient(baseSettings, { fetch: f }).generate(req);
    expect(res).toEqual({ text: 'Hello world', model: 'gemini-2.5-flash-001', finishReason: 'STOP', usage: { promptTokens: 3, outputTokens: 9, cachedTokens: 1 } });
    const h = f.calls[0]?.init.headers as Record<string, string>;
    expect(h['x-goog-api-key']).toBe('test-key');
    expect(h['authorization']).toBeUndefined();
    expect(f.calls[0]?.init.method).toBe('POST');
  });

  it('uses Bearer tokens for Vertex (access-token, injected provider) and ?key for express', async () => {
    const f1 = mockFetch(geminiJsonResponse('ok'));
    await createGeminiClient(vertex({ kind: 'access-token', accessToken: 'tok' }), { fetch: f1 }).generate(req);
    expect((f1.calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');

    const f2 = mockFetch(geminiJsonResponse('ok'));
    await createGeminiClient(vertex({ kind: 'adc' }), { fetch: f2, accessTokenProvider: async () => 'adc-tok' }).generate(req);
    expect((f2.calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer adc-tok');

    const f3 = mockFetch(geminiJsonResponse('ok'));
    await createGeminiClient(vertex({ kind: 'express-api-key', apiKey: 'xk' }), { fetch: f3 }).generate(req);
    expect(f3.calls[0]?.url).toContain('?key=xk');
    expect((f3.calls[0]?.init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('rejects ADC without a host provider as unsupported', async () => {
    const f = mockFetch();
    await expect(createGeminiClient(vertex({ kind: 'adc' }), { fetch: f }).generate(req)).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    [401, 'ai-auth'],
    [403, 'ai-auth'],
    [429, 'ai-quota'],
    [404, 'not-found'],
    [500, 'network'],
  ])('maps HTTP %i → %s', async (status, code) => {
    const f = mockFetch(new Response(JSON.stringify({ error: { message: 'boom' } }), { status }));
    await expect(createGeminiClient(baseSettings, { fetch: f }).generate(req)).rejects.toMatchObject({ code, message: 'boom', details: { status } });
  });

  it('maps invalid API key 400 to ai-auth', () => {
    expect(mapHttpErrorCode(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}')).toBe('ai-auth');
    expect(mapHttpErrorCode(400, 'bad')).toBe('invalid-argument');
  });

  it('maps safety blocks and empty/garbage bodies', async () => {
    const blocked = mockFetch(new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })));
    await expect(createGeminiClient(baseSettings, { fetch: blocked }).generate(req)).rejects.toMatchObject({ code: 'ai-safety' });
    const stopped = mockFetch(new Response(JSON.stringify({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] })));
    await expect(createGeminiClient(baseSettings, { fetch: stopped }).generate(req)).rejects.toMatchObject({ code: 'ai-safety' });
    const empty = mockFetch(new Response(JSON.stringify({})));
    await expect(createGeminiClient(baseSettings, { fetch: empty }).generate(req)).rejects.toMatchObject({ code: 'ai-invalid-response' });
    const garbage = mockFetch(new Response('<html>'));
    await expect(createGeminiClient(baseSettings, { fetch: garbage }).generate(req)).rejects.toMatchObject({ code: 'ai-invalid-response' });
  });

  it('maps network failures', async () => {
    const f = mockFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(createGeminiClient(baseSettings, { fetch: f }).generate(req)).rejects.toMatchObject({ code: 'network' });
  });

  /** fetch that never resolves until aborted. */
  const hanging = (): typeof fetch =>
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_res, rej) => {
          if (init.signal?.aborted) rej(new DOMException('aborted', 'AbortError'));
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );

  it('rejects with cancelled when the caller aborts', async () => {
    const ac = new AbortController();
    const p = createGeminiClient(baseSettings, { fetch: hanging() }).generate(req, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    const pre = new AbortController();
    pre.abort();
    await expect(createGeminiClient(baseSettings, { fetch: hanging() }).generate(req, pre.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects with ai-timeout on timeout', async () => {
    vi.useFakeTimers();
    try {
      const p = createGeminiClient({ ...baseSettings, timeoutMs: 1000 }, { fetch: hanging() }).generate(req);
      const assertion = expect(p).rejects.toMatchObject({ code: 'ai-timeout' });
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createGeminiClient.generateStream', () => {
  it('streams SSE deltas and aggregates usage', async () => {
    const f = mockFetch(
      sseResponse([
        { candidates: [{ content: { parts: [{ text: 'こん' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'にちは' }] } }] },
        { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 }, modelVersion: 'mv' },
      ]),
    );
    const deltas: string[] = [];
    const res = await createGeminiClient(baseSettings, { fetch: f }).generateStream(req, (d) => deltas.push(d));
    expect(deltas).toEqual(['こん', 'にちは']);
    expect(res).toEqual({ text: 'こんにちは', model: 'mv', finishReason: 'STOP', usage: { promptTokens: 2, outputTokens: 3 } });
    expect(f.calls[0]?.url).toContain(':streamGenerateContent?alt=sse');
  });

  it('reports malformed chunks as ai-invalid-response', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {nope\n\n'));
        c.close();
      },
    });
    const f = mockFetch(new Response(body));
    await expect(createGeminiClient(baseSettings, { fetch: f }).generateStream(req, () => {})).rejects.toMatchObject({ code: 'ai-invalid-response' });
  });
});

describe('readSseStream', () => {
  it('handles split chunks, comments, multi-line data and missing trailing newline', async () => {
    const enc = new TextEncoder();
    const parts = [': hello\n', 'data: a', 'b\ndata: c\n\n', 'data: {"x":1}\r', '\n\r\ndata: tail'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const got: string[] = [];
    await readSseStream(body, (d) => got.push(d));
    expect(got).toEqual(['ab\nc', '{"x":1}', 'tail']);
  });
});

describe('testAiConnection', () => {
  it('reports success and failure without throwing', async () => {
    let t = 0;
    const now = () => (t += 50);
    const ok = await testAiConnection(baseSettings, { fetch: mockFetch(geminiJsonResponse('OK')), now });
    expect(ok).toMatchObject({ ok: true, message: 'OK', latencyMs: 50 });
    const bad = await testAiConnection(baseSettings, { fetch: mockFetch(new Response('{}', { status: 401 })), now });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/^ai-auth/);
  });
});
