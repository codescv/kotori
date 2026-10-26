/**
 * AI wiring for Android: core's explain service (through the adapter's
 * `createAiEngine`: Gemini API key, Vertex access-token / service-account
 * JSON / express key — no ADC on device) over the WebView's *un-patched*
 * `fetch` (`deps.webFetch`: Google's Gemini / Vertex endpoints allow CORS, and
 * bypassing CapacitorHttp keeps response streaming and `AbortSignal` working
 * for follow-ups / cancelled explains) and an IndexedDB-backed
 * explanation cache + follow-up threads. ADC is unavailable on device.
 *
 * Cache hits must resolve in < 5 ms: explanations are mirrored in an
 * in-memory LRU in front of IndexedDB.
 */
import type { FollowUpMessage, SentenceExplanation } from '@kotori/core';
import { createAiEngine, type AiEngine, type ExplanationCache } from './adapters/core';
import type { HostContext } from './context';
import type { KotoriDb } from './storage/idb';

const MEMORY_LRU = 256;

/** `ExplanationCache` over the `explanations` + `threads` stores. */
export function createIdbExplanationCache(db: KotoriDb): ExplanationCache {
  const memory = new Map<string, SentenceExplanation>();
  const remember = (expl: SentenceExplanation): void => {
    memory.delete(expl.id);
    memory.set(expl.id, expl);
    while (memory.size > MEMORY_LRU) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  };
  return {
    async get(id) {
      const hot = memory.get(id);
      if (hot) return hot;
      const stored = await db.get('explanations', id);
      if (stored) remember(stored);
      return stored;
    },
    async put(explanation) {
      const stored: SentenceExplanation = { ...explanation, fromCache: false };
      await db.put('explanations', stored);
      remember(stored);
    },
    async getThread(id): Promise<readonly FollowUpMessage[]> {
      return (await db.get('threads', id))?.messages ?? [];
    },
    async appendThread(id, message) {
      const tx = db.transaction('threads', 'readwrite');
      const existing = await tx.store.get(id);
      await tx.store.put({ explanationId: id, messages: [...(existing?.messages ?? []), message] });
      await tx.done;
    },
    async clear() {
      const tx = db.transaction(['explanations', 'threads'], 'readwrite');
      const removed = await tx.objectStore('explanations').count();
      await Promise.all([tx.objectStore('explanations').clear(), tx.objectStore('threads').clear()]);
      await tx.done;
      memory.clear();
      return { removed };
    },
  };
}

/** AiApi + testAi for the Capacitor host. */
export function createAndroidAi(ctx: HostContext): AiEngine {
  return createAiEngine({
    settings: () => ctx.settings.current().ai,
    cache: createIdbExplanationCache(ctx.db),
    fetch: ctx.deps.webFetch,
    now: ctx.deps.now,
  });
}
