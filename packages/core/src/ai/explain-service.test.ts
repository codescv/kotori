import { describe, expect, it } from 'vitest';
import type { AiSettings, ExplainRequest, FollowUpDelta, SentenceExplanation } from '../types';
import { KotoriError } from '../util/errors';
import { explanationCacheKey } from './cache-key';
import { createExplainService, createMemoryExplanationCache } from './explain-service';
import { PROMPT_VERSION } from './prompts';
import { aiFixture, baseSettings, fakeClient } from './test-helpers';

const slang = aiFixture<{ sentence: string; raw: unknown }>('gemini-slang.json');
const rawText = JSON.stringify(slang.raw);

const req: ExplainRequest = { sentence: slang.sentence, source: { kind: 'manual' }, targetLanguage: 'zh-CN' };

function setup(responders: Parameters<typeof fakeClient>[0], settings: Partial<AiSettings> = {}) {
  const client = fakeClient(responders);
  const cache = createMemoryExplanationCache();
  let n = 0;
  const service = createExplainService({ client, cache, settings: () => ({ ...baseSettings, ...settings }), now: () => 5000, newId: (p) => `${p}${n++}` });
  return { client, cache, service };
}

describe('createExplainService.explain', () => {
  it('calls the model with schema + settings, aligns, caches and serves cache hits', async () => {
    const { client, cache, service } = setup([() => ({ text: rawText, usage: { promptTokens: 1, outputTokens: 1 } })], { thinkingBudget: 0 });
    const e = await service.explain(req);
    expect(e.id).toBe(await explanationCacheKey({ sentence: req.sentence, targetLanguage: 'zh-CN', model: 'gemini-2.5-flash', promptVersion: PROMPT_VERSION }));
    expect(e.fromCache).toBe(false);
    expect(e.chunks[1]?.textbookForm).toBe('ているのではない');
    const call = client.calls[0];
    expect(call).toMatchObject({ model: 'gemini-2.5-flash', responseMimeType: 'application/json', temperature: 0.2, thinkingBudget: 0, timeoutMs: 30_000 });
    expect(call?.responseSchema).toBeDefined();
    expect(await cache.get(e.id)).toEqual(e);

    const again = await service.explain(req);
    expect(again.fromCache).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect((await service.getCachedExplanation(req))?.fromCache).toBe(true);
  });

  it('force bypasses cache; cacheEnabled=false never reads or writes', async () => {
    const { client, service } = setup([() => ({ text: rawText }), () => ({ text: rawText })]);
    await service.explain(req);
    await service.explain({ ...req, force: true });
    expect(client.calls).toHaveLength(2);

    const off = setup([() => ({ text: rawText }), () => ({ text: rawText })], { cacheEnabled: false });
    await off.service.explain(req);
    await off.service.explain(req);
    expect(off.client.calls).toHaveLength(2);
    expect(await off.service.getCachedExplanation(req)).toBeUndefined();
  });

  it('retries once on invalid JSON with a nudge', async () => {
    const { client, service } = setup([() => ({ text: 'not json', usage: { promptTokens: 1, outputTokens: 1 } }), () => ({ text: rawText, usage: { promptTokens: 2, outputTokens: 2 } })]);
    const e = await service.explain(req);
    expect(e.usage).toEqual({ promptTokens: 3, outputTokens: 3 });
    expect(client.calls).toHaveLength(2);
    const retry = client.calls[1]!;
    expect(retry.contents.at(-2)).toEqual({ role: 'model', parts: [{ text: 'not json' }] });
    expect(JSON.stringify(retry.contents.at(-1))).toContain('valid JSON');
  });

  it('fails with ai-invalid-response after the retry', async () => {
    const { service } = setup([() => ({ text: '{"chunks":[]}' }), () => ({ text: '[]' })]);
    await expect(service.explain(req)).rejects.toMatchObject({ code: 'ai-invalid-response' });
  });

  it('rejects empty sentences', async () => {
    const { service } = setup([]);
    await expect(service.explain({ ...req, sentence: '  ' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('aborted calls reject with cancelled and never write the cache', async () => {
    const ac = new AbortController();
    const { cache, service } = setup([
      () => {
        ac.abort();
        return { text: rawText };
      },
    ]);
    await expect(service.explain(req, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(await cache.get(await explanationCacheKey({ sentence: req.sentence, targetLanguage: 'zh-CN', model: 'gemini-2.5-flash', promptVersion: PROMPT_VERSION }))).toBeUndefined();
    const pre = new AbortController();
    pre.abort();
    await expect(setup([]).service.explain(req, { signal: pre.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('maps client AbortErrors to cancelled when the caller aborted', async () => {
    const ac = new AbortController();
    const { service } = setup([
      () => {
        ac.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    ]);
    await expect(service.explain(req, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('propagates client errors', async () => {
    const { service } = setup([
      () => {
        throw new KotoriError('ai-quota', 'slow down');
      },
    ]);
    await expect(service.explain(req)).rejects.toMatchObject({ code: 'ai-quota' });
  });

  it('accepts a client factory (settings may change between calls)', async () => {
    const client = fakeClient([() => ({ text: rawText })]);
    const seen: string[] = [];
    const service = createExplainService({
      client: (s) => {
        seen.push(s.explainModel);
        return client;
      },
      cache: createMemoryExplanationCache(),
      settings: () => ({ ...baseSettings, explainModel: 'gemini-x' }),
    });
    const e = await service.explain(req);
    expect(seen).toEqual(['gemini-x']);
    expect(e.model).toBe('gemini-x');
  });
});

describe('createExplainService.followUp', () => {
  async function withExplanation() {
    const ctx = setup([() => ({ text: rawText }), () => ({ text: '  **答案**  ', usage: { promptTokens: 4, outputTokens: 5 } })]);
    const expl = await ctx.service.explain(req);
    return { ...ctx, expl };
  }

  it('uses the cached explanation, persists the thread and returns the model message', async () => {
    const { client, service, expl } = await withExplanation();
    const msg = await service.followUp({ explanationId: expl.id, history: [], question: 'なんで「ねぇ」？', targetLanguage: 'zh-CN' });
    expect(msg).toEqual({ id: 'm1', role: 'model', text: '**答案**', createdAt: 5000, usage: { promptTokens: 4, outputTokens: 5 } });
    expect(client.calls[1]?.systemInstruction).toContain('ているのではない');
    expect(client.calls[1]?.contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'なんで「ねぇ」？' }] });
    const thread = await service.getThread(expl.id);
    expect(thread.map((m) => [m.role, m.text])).toEqual([
      ['user', 'なんで「ねぇ」？'],
      ['model', '**答案**'],
    ]);
  });

  it('prefers request.explanation (works with cacheEnabled=false)', async () => {
    const { service, expl } = await withExplanation();
    const other = setup([() => ({ text: 'ok' })], { cacheEnabled: false });
    const msg = await other.service.followUp({ explanationId: 'missing', explanation: expl as SentenceExplanation, history: [], question: 'q', targetLanguage: 'en' });
    expect(msg.text).toBe('ok');
    void service;
  });

  it('rejects not-found when neither explanation nor cache entry exists, and empty questions', async () => {
    const { service } = setup([]);
    await expect(service.followUp({ explanationId: 'nope', history: [], question: 'q', targetLanguage: 'en' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(service.followUp({ explanationId: 'nope', history: [], question: ' ', targetLanguage: 'en' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('streams deltas then a final done delta with usage', async () => {
    const { service, expl } = await withExplanation();
    const deltas: FollowUpDelta[] = [];
    const msg = await service.followUpStream({ explanationId: expl.id, history: [], question: 'q', targetLanguage: 'zh-CN' }, (d) => deltas.push(d));
    expect(deltas.filter((d) => !d.done).map((d) => d.textDelta).join('')).toBe('  **答案**  ');
    expect(deltas.at(-1)).toEqual({ messageId: msg.id, textDelta: '', done: true, usage: { promptTokens: 4, outputTokens: 5 } });
    expect(deltas.every((d) => d.messageId === msg.id)).toBe(true);
  });

  it('aborted follow-ups do not append to the thread', async () => {
    const ac = new AbortController();
    const ctx = setup([
      () => ({ text: rawText }),
      () => {
        ac.abort();
        return { text: 'late' };
      },
    ]);
    const expl = await ctx.service.explain(req);
    await expect(ctx.service.followUp({ explanationId: expl.id, history: [], question: 'q', targetLanguage: 'en' }, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(await ctx.service.getThread(expl.id)).toEqual([]);
  });

  it('clearCache empties explanations and threads', async () => {
    const { service, expl } = await withExplanation();
    expect(await service.clearCache()).toEqual({ removed: 1 });
    expect(await service.getCachedExplanation(req)).toBeUndefined();
    expect(await service.getThread(expl.id)).toEqual([]);
  });

  it('defaults omitted targetLanguage and history for raw REST callers', async () => {
    const { service } = setup([() => ({ text: rawText }), () => ({ text: '答1' }), () => ({ text: '答2' })], { targetLanguage: 'zh-CN' });
    const rawExplainReq = { sentence: '食べてんじゃねぇよ' } as unknown as ExplainRequest;
    const expl = await service.explain(rawExplainReq);
    expect(expl.targetLanguage).toBe('zh-CN');
    expect((await service.getCachedExplanation(rawExplainReq))?.id).toBe(expl.id);

    const rawFollowUp1 = { explanationId: expl.id, question: 'Q1' } as unknown as Parameters<typeof service.followUp>[0];
    const m1 = await service.followUp(rawFollowUp1);
    expect(m1.text).toBe('答1');

    const rawFollowUp2 = { explanationId: expl.id, question: 'Q2' } as unknown as Parameters<typeof service.followUp>[0];
    const m2 = await service.followUp(rawFollowUp2);
    expect(m2.text).toBe('答2');
    expect((await service.getThread(expl.id)).map((m) => m.text)).toEqual(['Q1', '答1', 'Q2', '答2']);
  });
});

describe('createExplainService vision', () => {
  const image = { mimeType: 'image/png', base64: 'AA', width: 10, height: 10 };
  it('ocrBubble with explain=true runs the explain pipeline on the OCR text', async () => {
    const { client, service } = setup([() => ({ text: JSON.stringify({ lines: ['食べてん', 'じゃねぇよ'], vertical: true, confidence: 1.4 }) }), () => ({ text: rawText })]);
    const res = await service.ocrBubble({ volumeId: 'vol', pageIndex: 2, rect: { left: 1, top: 2, right: 3, bottom: 4 }, image, explain: true, targetLanguage: 'zh-CN' });
    expect(res).toMatchObject({ volumeId: 'vol', pageIndex: 2, lines: ['食べてん', 'じゃねぇよ'], text: '食べてんじゃねぇよ', vertical: true, confidence: 1, createdAt: 5000 });
    expect(res.explanation?.sentence).toBe('食べてんじゃねぇよ');
    expect(client.calls[0]?.model).toBe('gemini-2.5-flash');
    expect(client.calls[1]?.responseSchema).toBeDefined();
  });

  it('pageGuide uses the vision model', async () => {
    const { client, service } = setup([() => ({ text: JSON.stringify({ summary: 's', bubbles: [] }) })], { visionModel: 'vision-x' });
    const res = await service.pageGuide({ volumeId: 'v', pageIndex: 0, image, targetLanguage: 'en' });
    expect(res).toMatchObject({ summary: 's', bubbles: [], model: 'vision-x' });
    expect(client.calls[0]?.model).toBe('vision-x');
  });
});
