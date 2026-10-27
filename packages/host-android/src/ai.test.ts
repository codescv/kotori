import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExplainRequest, FollowUpDelta, SentenceExplanation } from '@kotori/core';
import { PROMPT_VERSION, explanationCacheKey } from './adapters/core';
import { createIdbExplanationCache } from './ai';
import { openKotoriDb } from './storage/idb';
import { createTestHost, pngHeader, type TestHost } from './testing/harness';
import { fixtureText } from './testing/fixtures';

const open: TestHost[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.host.dispose()));
});

const SLANG = JSON.parse(fixtureText('gemini-slang.json')) as { sentence: string; raw: unknown };

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      modelVersion: 'gemini-2.5-flash-001',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function sseResponse(chunks: readonly string[]): Response {
  const body = chunks
    .map((c) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: c }] } }] })}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Host with a scripted Gemini `fetch` (records calls) and an API key configured. */
async function aiHost(responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): Promise<TestHost & { calls: string[] }> {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return responder(url, init);
  });
  const t = await createTestHost({ fetch: fetchImpl });
  open.push(t);
  await t.host.settings.update({ ai: { provider: { provider: 'gemini-api', apiKey: 'test-key' } } });
  return { ...t, calls };
}

const request = (sentence: string): ExplainRequest => ({ sentence, source: { kind: 'manual' }, targetLanguage: 'zh-CN' });

describe('ai (core explain service over IndexedDB cache)', () => {
  it('explains through Gemini REST, caches by explanationCacheKey and hits the cache afterwards', async () => {
    const t = await aiHost(() => geminiResponse(JSON.stringify(SLANG.raw)));
    const req = request(SLANG.sentence);
    expect(await t.host.ai.getCachedExplanation(req)).toBeUndefined();

    const fresh = await t.host.ai.explain(req);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toContain('generativelanguage.googleapis.com');
    expect(t.calls[0]).toContain('gemini-3.5-flash-lite:generateContent');
    expect(fresh.sentence).toBe(SLANG.sentence);
    expect(fresh.fromCache).toBe(false);
    expect(fresh.ruby.map((r) => r.base).join('')).toBe(SLANG.sentence);
    expect(fresh.chunks.some((c) => c.textbookForm.includes('ている'))).toBe(true);
    expect(fresh.id).toBe(await explanationCacheKey({ sentence: SLANG.sentence, targetLanguage: 'zh-CN', model: 'gemini-3.5-flash-lite', promptVersion: PROMPT_VERSION }));

    const cached = await t.host.ai.getCachedExplanation(req);
    expect(cached).toMatchObject({ id: fresh.id, fromCache: true });
    const again = await t.host.ai.explain(req);
    expect(again.fromCache).toBe(true);
    expect(t.calls).toHaveLength(1);

    // Persisted in IndexedDB: a new host over the same DB still hits.
    await t.host.dispose();
    const reopened = await createTestHost({ fetch: () => Promise.reject(new Error('offline')) }, { fs: t.fs, idbFactory: t.idbFactory, clock: t.clock });
    open.push(reopened);
    expect((await reopened.host.ai.getCachedExplanation(req))?.id).toBe(fresh.id);
  });

  it('honours cacheEnabled=false and force', async () => {
    const t = await aiHost(() => geminiResponse(JSON.stringify(SLANG.raw)));
    const req = request(SLANG.sentence);
    await t.host.ai.explain(req);
    await t.host.ai.explain({ ...req, force: true });
    expect(t.calls).toHaveLength(2);
    await t.host.settings.update({ ai: { cacheEnabled: false } });
    expect(await t.host.ai.getCachedExplanation(req)).toBeUndefined();
  });

  it('rejects with cancelled for an aborted signal and maps HTTP 401 to ai-auth', async () => {
    const t = await aiHost(() => new Response('{"error":{"code":401,"message":"bad key"}}', { status: 401 }));
    const controller = new AbortController();
    controller.abort();
    await expect(t.host.ai.explain(request('猫'), { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(t.host.ai.explain(request('猫'))).rejects.toMatchObject({ code: 'ai-auth' });
    const result = await t.host.settings.testAi();
    expect(result).toMatchObject({ ok: false, model: 'gemini-3.5-flash-lite' });
    expect(result.message).toMatch(/^ai-auth/);
  });

  it('follow-ups persist a thread (streaming and non-streaming); clearCache removes everything', async () => {
    let call = 0;
    const t = await aiHost((url) => {
      call++;
      if (call === 1) return geminiResponse(JSON.stringify(SLANG.raw));
      if (url.includes('streamGenerateContent')) return sseResponse(['「てん」は', '「ている」の縮約です。']);
      return geminiResponse('「じゃねぇ」は「ではない」の口語形です。');
    });
    const expl = await t.host.ai.explain(request(SLANG.sentence));
    const answer = await t.host.ai.followUp({ explanationId: expl.id, history: [], question: 'じゃねぇ是什么？', targetLanguage: 'zh-CN' });
    expect(answer).toMatchObject({ role: 'model', text: '「じゃねぇ」は「ではない」の口語形です。' });

    const deltas: FollowUpDelta[] = [];
    const streamed = await t.host.ai.followUpStream?.(
      { explanationId: expl.id, explanation: expl, history: await t.host.ai.getThread(expl.id), question: 'てん呢？', targetLanguage: 'zh-CN' },
      (d) => deltas.push(d),
    );
    expect(streamed?.text).toBe('「てん」は「ている」の縮約です。');
    expect(deltas.map((d) => d.textDelta).join('')).toBe('「てん」は「ている」の縮約です。');
    expect(deltas.at(-1)?.done).toBe(true);

    const thread = await t.host.ai.getThread(expl.id);
    expect(thread.map((m) => m.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(thread[0]?.text).toBe('じゃねぇ是什么？');

    await expect(t.host.ai.followUp({ explanationId: 'ex_missing', history: [], question: '?', targetLanguage: 'zh-CN' })).rejects.toMatchObject({ code: 'not-found' });

    expect(await t.host.ai.clearCache()).toEqual({ removed: 1 });
    expect(await t.host.ai.getThread(expl.id)).toEqual([]);
    expect(await t.host.ai.getCachedExplanation(request(SLANG.sentence))).toBeUndefined();
  });

  it('ocrBubble runs vision + explain in one host call', async () => {
    let call = 0;
    const t = await aiHost(() => {
      call++;
      if (call === 1) return geminiResponse(JSON.stringify({ lines: ['食べてんじゃ', 'ねぇよ'], vertical: true, confidence: 0.9 }));
      return geminiResponse(JSON.stringify(SLANG.raw));
    });
    const result = await t.host.ai.ocrBubble({
      volumeId: 'v',
      pageIndex: 0,
      rect: { left: 0, top: 0, right: 10, bottom: 10 },
      image: { mimeType: 'image/png', base64: btoa(String.fromCharCode(...pngHeader(10, 10))), width: 10, height: 10 },
      explain: true,
      targetLanguage: 'zh-CN',
    });
    expect(result.text).toBe('食べてんじゃねぇよ');
    expect(result.explanation?.sentence).toBe('食べてんじゃねぇよ');
  });
});

describe('createIdbExplanationCache', () => {
  it('stores explanations and threads, clear() reports removed count', async () => {
    const t = await createTestHost();
    open.push(t);
    const db = await openKotoriDb(t.idbFactory, 'cache-only');
    const cache = createIdbExplanationCache(db);
    const expl = { id: 'ex_1', sentence: 's', fromCache: true } as unknown as SentenceExplanation;
    await cache.put(expl);
    expect((await cache.get('ex_1'))?.fromCache).toBe(false);
    await cache.appendThread('ex_1', { id: 'm1', role: 'user', text: 'q', createdAt: 1 });
    await cache.appendThread('ex_1', { id: 'm2', role: 'model', text: 'a', createdAt: 2 });
    expect((await cache.getThread('ex_1')).map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(await cache.clear()).toEqual({ removed: 1 });
    expect(await cache.get('ex_1')).toBeUndefined();
    expect(await cache.getThread('ex_1')).toEqual([]);
    db.close();
  });
});
