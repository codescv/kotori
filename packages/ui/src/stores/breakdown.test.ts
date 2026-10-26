import { beforeEach, describe, expect, it } from 'vitest';
import type { ExplainSource } from '@kotori/core';
import { createMockPlatformHost } from '../host/mock-host';
import { resetStores } from '../test/utils';
import { useBreakdownStore } from './breakdown';

const SENTENCE = '食べてんじゃねぇよ！';
const source: ExplainSource = { kind: 'subtitle', episodeId: 'e', trackId: 't', cueIndexes: [7], cueCharSpans: [[0, SENTENCE.length]], startMs: 0, endMs: 1000 };
const store = () => useBreakdownStore.getState();

describe('useBreakdownStore (click → highlight contract §6.2)', () => {
  beforeEach(resetStores);

  it('first click explains via the host; same-sentence clicks only move focus synchronously', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    await store().open(host, { sentence: SENTENCE, source, focusCharIndex: 1 });
    expect(store().status).toBe('ready');
    expect(store().explanation?.sentence).toBe(SENTENCE);
    expect(host.calls.get('ai.explain')).toBe(1);

    const cachedProbes = host.calls.get('ai.getCachedExplanation');
    void store().open(host, { sentence: SENTENCE, source, focusCharIndex: 5 });
    // Synchronous: no await needed, no host round-trip at all.
    expect(store().focusCharIndex).toBe(5);
    expect(host.calls.get('ai.explain')).toBe(1);
    expect(host.calls.get('ai.getCachedExplanation')).toBe(cachedProbes);
  });

  it('a cache hit never calls ai.explain', async () => {
    const host = createMockPlatformHost({ latencyMs: 0, precachedSentences: [SENTENCE] });
    await store().open(host, { sentence: SENTENCE, source, focusCharIndex: 0 });
    expect(store().explanation?.fromCache).toBe(true);
    expect(host.calls.get('ai.explain')).toBeUndefined();
  });

  it('a new sentence aborts the in-flight explain and ignores its cancellation', async () => {
    const host = createMockPlatformHost({ latencyMs: 20 });
    const first = store().open(host, { sentence: 'ちょっと待ってくれよ、まだ話は終わってないんだから。', source, focusCharIndex: 0 });
    expect(store().status).toBe('loading');
    const second = store().open(host, { sentence: SENTENCE, source, focusCharIndex: 2 });
    await Promise.all([first, second]);
    expect(store().status).toBe('ready');
    expect(store().error).toBeUndefined();
    expect(store().explanation?.sentence).toBe(SENTENCE);
  });

  it('maps host errors to an error state with its code', async () => {
    const host = createMockPlatformHost({ latencyMs: 0, settings: { ai: { provider: { provider: 'gemini-api', apiKey: 'invalid' } } } });
    await store().open(host, { sentence: '新しい文', source, focusCharIndex: 0 });
    expect(store().status).toBe('error');
    expect(store().error?.code).toBe('ai-auth');
  });

  it('streams follow-up answers and restores the thread when reopened', async () => {
    const host = createMockPlatformHost({ latencyMs: 0, streamDelayMs: 0 });
    await store().open(host, { sentence: SENTENCE, source, focusCharIndex: 0 });
    await store().askFollowUp(host, '换成礼貌说法怎么说？');
    expect(host.calls.get('ai.followUpStream')).toBe(1);
    const thread = store().thread;
    expect(thread.map((m) => m.role)).toEqual(['user', 'model']);
    expect(thread[1]?.text).toContain('です・ます');
    expect(store().followUpPending).toBe(false);

    store().reset();
    await store().open(host, { sentence: SENTENCE, source, focusCharIndex: 0 });
    expect(store().thread.length).toBe(2);
  });

  it('falls back to non-streaming followUp when the host cannot stream', async () => {
    const host = createMockPlatformHost({ latencyMs: 0, capabilities: { streaming: false } });
    await store().open(host, { sentence: SENTENCE, source, focusCharIndex: 0 });
    await store().askFollowUp(host, '再给我两个例句');
    expect(host.calls.get('ai.followUp')).toBe(1);
    expect(host.calls.get('ai.followUpStream')).toBeUndefined();
  });
});
