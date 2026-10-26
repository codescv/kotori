import { describe, expect, it, vi } from 'vitest';
import type { AiSettings, FollowUpMessage, SentenceExplanation } from '@kotori/core';
import { adcTokenProvider } from './credentials';
import { createAiService, createSqliteExplanationCache } from './service';
import { openDatabase } from '../db/sqlite';
import { createRepositories } from '../db/repositories';

const base: AiSettings = {
  provider: { provider: 'gemini-api', apiKey: 'k' },
  explainModel: 'gemini-2.5-flash',
  visionModel: 'gemini-2.5-flash-vision',
  temperature: 0.2,
  targetLanguage: 'zh-CN',
  cacheEnabled: true,
  timeoutMs: 30_000,
};

function okResponse(text = 'OK'): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: 'gemini-2.5-flash' });
}

describe('adcTokenProvider', () => {
  it('returns tokens from the injected GoogleAuth-like client', async () => {
    const getAccessToken = vi.fn(async () => 'fake-adc-token');
    const provider = adcTokenProvider({ getAccessToken });
    await expect(provider()).resolves.toBe('fake-adc-token');
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('maps failures and empty tokens to ai-auth with a gcloud hint', async () => {
    await expect(adcTokenProvider({ getAccessToken: async () => null })()).rejects.toMatchObject({ code: 'ai-auth' });
    const err = await adcTokenProvider({
      getAccessToken: async () => {
        throw new Error('Could not load the default credentials');
      },
    })().catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'ai-auth' });
    expect((err as Error).message).toContain('gcloud auth application-default login');
  });
});

describe('createAiService', () => {
  it('uses the injected ADC token as Bearer for Vertex AI (global endpoint)', async () => {
    const db = openDatabase(':memory:');
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return okResponse();
    }) as unknown as typeof globalThis.fetch;
    const settings: AiSettings = { ...base, provider: { provider: 'vertex-ai', project: 'proj', location: 'global', auth: { kind: 'adc' } } };
    const ai = createAiService({ repos: createRepositories(db), settings: () => settings, adc: async () => 'adc-token', fetch });
    const result = await ai.testConnection(settings);
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google/models/gemini-2.5-flash:generateContent');
    expect(calls[0]?.auth).toBe('Bearer adc-token');
    db.close();
  });

  it('reports a failed connection test instead of throwing when ADC is missing', async () => {
    const db = openDatabase(':memory:');
    const settings: AiSettings = { ...base, provider: { provider: 'vertex-ai', project: 'p', location: 'us-central1', auth: { kind: 'adc' } } };
    const ai = createAiService({ repos: createRepositories(db), settings: () => settings, fetch: async () => okResponse() });
    const result = await ai.testConnection(settings);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unsupported|Application Default Credentials/i);
    db.close();
  });

  it('applies settings changes per call (no restart needed)', async () => {
    const db = openDatabase(':memory:');
    let settings: AiSettings = base;
    const urls: string[] = [];
    const ai = createAiService({
      repos: createRepositories(db),
      settings: () => settings,
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return okResponse('answer');
      }) as typeof fetch,
    });
    const expl = { id: 'ex_1', sentence: 'あ', ruby: [], translation: 'a', chunks: [], vocab: [], grammar: [], targetLanguage: 'zh-CN', model: 'm', promptVersion: 'v1', createdAt: 1, fromCache: false } as SentenceExplanation;
    await ai.followUp({ explanationId: 'ex_1', explanation: expl, history: [], question: 'q', targetLanguage: 'zh-CN' });
    settings = { ...base, provider: { provider: 'gemini-api', apiKey: 'k2', baseUrl: 'https://proxy.example' } };
    await ai.followUp({ explanationId: 'ex_1', explanation: expl, history: [], question: 'q2', targetLanguage: 'zh-CN' });
    expect(urls[0]).toContain('generativelanguage.googleapis.com');
    expect(urls[1]).toContain('https://proxy.example/');
    expect((await ai.getThread('ex_1')).length).toBe(4);
    db.close();
  });
});

describe('createSqliteExplanationCache', () => {
  it('skips writes when caching is disabled but keeps threads', async () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db);
    let enabled = false;
    const cache = createSqliteExplanationCache(repos, () => ({ ...base, cacheEnabled: enabled }));
    const expl = { id: 'ex_9', sentence: 's', targetLanguage: 'en', model: 'm', promptVersion: 'v1', createdAt: 1, fromCache: false } as unknown as SentenceExplanation;
    await cache.put(expl);
    expect(await cache.get('ex_9')).toBeUndefined();
    enabled = true;
    await cache.put(expl);
    expect((await cache.get('ex_9'))?.id).toBe('ex_9');
    const msg: FollowUpMessage = { id: 'm1', role: 'user', text: 'hi', createdAt: 2 };
    await cache.appendThread('ex_9', msg);
    expect(await cache.getThread('ex_9')).toEqual([msg]);
    expect(await cache.clear()).toEqual({ removed: 1 });
    expect(await cache.getThread('ex_9')).toEqual([]);
    db.close();
  });
});
