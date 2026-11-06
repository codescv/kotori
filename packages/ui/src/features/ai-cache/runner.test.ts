import { describe, expect, it, vi } from 'vitest';
import { KotoriError, type ExplainRequest, type SentenceExplanation } from '@kotori/core';
import { BATCH_CHUNK_SIZE, BATCH_CONCURRENCY, probeCachedStatus, runExplainCache, type ExplainCacheAi } from './runner';

const req = (sentence: string, extra: Partial<ExplainRequest> = {}): ExplainRequest => ({ sentence, source: { kind: 'manual' }, targetLanguage: 'zh-CN', ...extra });
const expl = (r: ExplainRequest): SentenceExplanation => ({ id: r.sentence, sentence: r.sentence }) as unknown as SentenceExplanation;

/** Fake AiApi over an in-memory cache with scriptable failures and concurrency tracking. */
function fakeAi(opts: { cached?: readonly string[]; failBatch?: (reqs: readonly ExplainRequest[], call: number) => Error | undefined; delayMs?: number; noStatus?: boolean } = {}) {
  const cache = new Set(opts.cached ?? []);
  const batches: string[][] = [];
  const singles: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let statusCalls = 0;
  let getCalls = 0;
  const delay = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, opts.delayMs ?? 1);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new KotoriError('cancelled', 'aborted'));
      });
    });
  const ai: ExplainCacheAi = {
    async explain(r, o) {
      singles.push(r.sentence);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await delay(o?.signal);
        const err = opts.failBatch?.([r], batches.length + singles.length);
        if (err) throw err;
        cache.add(r.sentence);
        return expl(r);
      } finally {
        inFlight--;
      }
    },
    async explainBatch(reqs, o) {
      batches.push(reqs.map((r) => r.sentence));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await delay(o?.signal);
        const err = opts.failBatch?.(reqs, batches.length);
        if (err) throw err;
        for (const r of reqs) cache.add(r.sentence);
        return reqs.map(expl);
      } finally {
        inFlight--;
      }
    },
    async getCachedExplanation(r) {
      getCalls++;
      return cache.has(r.sentence) ? expl(r) : undefined;
    },
    ...(opts.noStatus
      ? {}
      : {
          async getCachedStatus(reqs: readonly { sentence: string }[]) {
            statusCalls++;
            return reqs.map((r) => cache.has(r.sentence));
          },
        }),
  };
  return {
    ai,
    cache,
    batches,
    singles,
    get maxInFlight() {
      return maxInFlight;
    },
    get statusCalls() {
      return statusCalls;
    },
    get getCalls() {
      return getCalls;
    },
  };
}

const sentences = (n: number, prefix = '文'): ExplainRequest[] => Array.from({ length: n }, (_, i) => req(`${prefix}${i}です`));

describe('runExplainCache', () => {
  it('chunks uncached sentences by 8 with at most 3 concurrent explainBatch calls, after ONE bulk probe', async () => {
    const f = fakeAi({ delayMs: 5 });
    const settled: number[] = [];
    const result = await runExplainCache({ ai: f.ai, requests: sentences(50), onChunkSettled: (reqs, o) => settled.push(o.ok.length) });
    expect(BATCH_CHUNK_SIZE).toBe(8);
    expect(BATCH_CONCURRENCY).toBe(3);
    expect(result).toEqual({ total: 50, cachedInitially: 0, completed: 50, failed: 0 });
    expect(f.statusCalls).toBe(1);
    expect(f.getCalls).toBe(0);
    expect(f.batches).toHaveLength(7);
    expect(f.batches.every((b) => b.length <= 8)).toBe(true);
    expect(f.maxInFlight).toBeLessThanOrEqual(3);
    expect(f.maxInFlight).toBeGreaterThan(1);
    expect(settled.reduce((a, b) => a + b, 0)).toBe(50);
    expect(f.cache.size).toBe(50);
  });

  it('deduplicates repeated sentences (keeping the richest context) and skips already-cached ones at 0 LLM cost', async () => {
    const f = fakeAi({ cached: ['文0です', '文1です'] });
    const requests = [req('同じ台詞'), ...sentences(4), req('同じ台詞', { contextBefore: ['前の行'], contextAfter: ['次の行'] }), req('同じ台詞')];
    const checked = vi.fn();
    const result = await runExplainCache({ ai: f.ai, requests, onChecked: checked });
    expect(result).toEqual({ total: 5, cachedInitially: 2, completed: 3, failed: 0 });
    expect(checked).toHaveBeenCalledWith(expect.objectContaining({ total: 5, cached: 2 }));
    expect(f.batches).toEqual([['同じ台詞', '文2です', '文3です']]);

    // Resume: everything cached ⇒ probe only, no model call at all.
    const again = await runExplainCache({ ai: f.ai, requests });
    expect(again).toEqual({ total: 5, cachedInitially: 5, completed: 0, failed: 0 });
    expect(f.batches).toHaveLength(1);
  });

  it('sends the richest-context duplicate to the model', async () => {
    const f = fakeAi();
    const sent: ExplainRequest[][] = [];
    const ai: ExplainCacheAi = { ...f.ai, explainBatch: async (reqs, o) => (sent.push([...reqs]), f.ai.explainBatch!(reqs, o)) };
    await runExplainCache({ ai, requests: [req('同じ台詞'), req('別の台詞'), req('同じ台詞', { contextBefore: ['a', 'b'], speaker: '湊' })] });
    expect(sent[0]?.[0]).toMatchObject({ sentence: '同じ台詞', contextBefore: ['a', 'b'], speaker: '湊' });
  });

  it('splits a failing 8-item batch into halves down to single sentences; only the poisoned line fails', async () => {
    const f = fakeAi({
      failBatch: (reqs) => (reqs.some((r) => r.sentence === '文5です') ? new KotoriError('ai-invalid-response', 'truncated JSON') : undefined),
    });
    const result = await runExplainCache({ ai: f.ai, requests: sentences(8) });
    expect(result).toEqual({ total: 8, cachedInitially: 0, completed: 7, failed: 1 });
    expect(f.cache.has('文5です')).toBe(false);
    expect(f.cache.has('文7です')).toBe(true);
    // 8 → 4+4 → (2+2) → (1+1)
    expect(f.batches[0]).toHaveLength(8);
    expect(f.batches.some((b) => b.length === 4)).toBe(true);
    expect(f.batches).toContainEqual(['文5です']);
    expect(f.singles).toHaveLength(0);
  });

  it('retries rate-limited (429) batches with exponential backoff instead of splitting', async () => {
    let failures = 2;
    const f = fakeAi({
      failBatch: () => (failures-- > 0 ? new KotoriError('ai-quota', 'Resource exhausted', { details: { status: 429 } }) : undefined),
    });
    const sleeps: number[] = [];
    const result = await runExplainCache({ ai: f.ai, requests: sentences(8), backoffMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    expect(result.completed).toBe(8);
    expect(sleeps).toEqual([100, 200]);
    expect(f.batches).toHaveLength(3);
    expect(f.batches.every((b) => b.length === 8)).toBe(true);
  });

  it('marks a chunk failed after exhausting rate-limit retries and carries on with the rest', async () => {
    const f = fakeAi({ failBatch: (reqs) => (reqs[0]?.sentence === '文0です' ? new KotoriError('ai-quota', '429') : undefined) });
    const result = await runExplainCache({ ai: f.ai, requests: sentences(16), maxRetries: 2, concurrency: 1, sleep: async () => {} });
    expect(result).toEqual({ total: 16, cachedInitially: 0, completed: 8, failed: 8 });
  });

  it('aborts the whole job on auth errors', async () => {
    const f = fakeAi({ failBatch: () => new KotoriError('ai-auth', 'API key not valid') });
    await expect(runExplainCache({ ai: f.ai, requests: sentences(20) })).rejects.toMatchObject({ code: 'ai-auth' });
    expect(f.batches.length).toBeLessThanOrEqual(3);
  });

  it('cancels via AbortController: in-flight chunks abort, finished chunks stay cached, and a re-run resumes only the rest', async () => {
    const f = fakeAi({ delayMs: 20 });
    const controller = new AbortController();
    let settledChunks = 0;
    const run = runExplainCache({
      ai: f.ai,
      requests: sentences(48),
      signal: controller.signal,
      concurrency: 1,
      onChunkSettled: () => {
        settledChunks++;
        if (settledChunks === 2) controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.cache.size).toBe(16);
    const before = f.batches.length;
    const resumed = await runExplainCache({ ai: f.ai, requests: sentences(48) });
    expect(resumed).toEqual({ total: 48, cachedInitially: 16, completed: 32, failed: 0 });
    expect(f.batches.length - before).toBe(4);
  });

  it('falls back to explain() per sentence for hosts without explainBatch', async () => {
    const f = fakeAi();
    const { explainBatch: _drop, ...noBatch } = f.ai;
    const result = await runExplainCache({ ai: noBatch, requests: sentences(3) });
    expect(result.completed).toBe(3);
    expect(f.singles).toHaveLength(3);
  });
});

describe('probeCachedStatus', () => {
  it('uses one getCachedStatus call per 2000 requests', async () => {
    const f = fakeAi({ cached: ['文1です'] });
    const status = await probeCachedStatus(f.ai, sentences(2500));
    expect(status).toHaveLength(2500);
    expect(status[1]).toBe(true);
    expect(status.filter(Boolean)).toHaveLength(1);
    expect(f.statusCalls).toBe(2);
  });

  it('falls back to bounded-parallel getCachedExplanation on hosts without the bulk API', async () => {
    const f = fakeAi({ cached: ['文2です'], noStatus: true });
    const status = await probeCachedStatus(f.ai, sentences(40));
    expect(status.filter(Boolean)).toHaveLength(1);
    expect(status[2]).toBe(true);
    expect(f.getCalls).toBe(40);
  });
});
