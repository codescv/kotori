/**
 * 「缓存AI解读」 batch runner: dedupe → one bulk cache probe → uncached
 * sentences in chunks of {@link BATCH_CHUNK_SIZE} through a worker pool of
 * {@link BATCH_CONCURRENCY} `ai.explainBatch` calls. Each chunk is persisted
 * by the host as soon as it finishes, so cancelling keeps everything done so
 * far and re-running resumes with only the remaining sentences (0 tokens for
 * the cached ones).
 *
 * Resilience: rate limits / network blips retry with exponential backoff; a
 * batch that fails otherwise (truncated JSON, timeout, safety block) is split
 * in halves down to single sentences, so one tricky line never aborts a whole
 * volume. Auth / unsupported errors abort the job.
 */
import type { AiApi, ExplainRequest, KotoriErrorCode } from '@kotori/core';
import { dedupeBySentence } from './collect';

export const BATCH_CHUNK_SIZE = 8;
export const BATCH_CONCURRENCY = 3;
/** Max requests per `getCachedStatus` call (host limit is 5000). */
export const STATUS_PROBE_CHUNK = 2000;
const FALLBACK_PROBE_CONCURRENCY = 16;

export type ExplainCacheAi = Pick<AiApi, 'explain' | 'explainBatch' | 'getCachedExplanation' | 'getCachedStatus'>;

export interface ChunkOutcome {
  readonly ok: readonly ExplainRequest[];
  readonly failed: readonly ExplainRequest[];
}

export interface RunExplainCacheOptions {
  readonly ai: ExplainCacheAi;
  readonly requests: readonly ExplainRequest[];
  readonly signal?: AbortSignal | undefined;
  readonly chunkSize?: number;
  readonly concurrency?: number;
  /** Retries per chunk on `ai-quota` (HTTP 429) / `network` (default 4). */
  readonly maxRetries?: number;
  /** First backoff delay; doubles per retry (default 2000 ms). */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** After the bulk probe: unique sentences and how many were already cached. */
  readonly onChecked?: (info: { readonly total: number; readonly cached: number; readonly cachedRequests: readonly ExplainRequest[] }) => void;
  readonly onChunkStart?: (requests: readonly ExplainRequest[]) => void;
  readonly onChunkSettled?: (requests: readonly ExplainRequest[], outcome: ChunkOutcome) => void;
}

export interface ExplainCacheResult {
  readonly total: number;
  readonly cachedInitially: number;
  readonly completed: number;
  readonly failed: number;
}

const RETRYABLE: ReadonlySet<KotoriErrorCode> = new Set(['ai-quota', 'network']);
const FATAL: ReadonlySet<KotoriErrorCode> = new Set(['ai-auth', 'unsupported', 'cancelled']);

function errorCode(e: unknown): KotoriErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (code as KotoriErrorCode) : undefined;
}

function isRateLimited(e: unknown): boolean {
  const code = errorCode(e);
  if (code && RETRYABLE.has(code)) return true;
  const status = (e as { details?: { status?: unknown } } | null)?.details?.status;
  return status === 429 || status === 503;
}

function cancelledError(): Error {
  return Object.assign(new Error('Request cancelled'), { code: 'cancelled' as const });
}

/** Abortable sleep. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Split into chunks of `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One boolean per request: already cached? Uses the host's bulk
 * `getCachedStatus` (one round-trip per {@link STATUS_PROBE_CHUNK}) and falls
 * back to bounded-parallel `getCachedExplanation` on older hosts.
 */
export async function probeCachedStatus(ai: ExplainCacheAi, requests: readonly ExplainRequest[]): Promise<boolean[]> {
  if (requests.length === 0) return [];
  if (ai.getCachedStatus) {
    const out: boolean[] = [];
    for (const part of chunk(requests, STATUS_PROBE_CHUNK)) {
      const status = await ai.getCachedStatus(part.map((r) => ({ sentence: r.sentence, targetLanguage: r.targetLanguage })));
      part.forEach((_, i) => out.push(Boolean(status[i])));
    }
    return out;
  }
  const out: boolean[] = new Array<boolean>(requests.length).fill(false);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < requests.length) {
      const i = next++;
      const hit = await ai.getCachedExplanation(requests[i]!).catch(() => undefined);
      out[i] = hit !== undefined;
    }
  };
  await Promise.all(Array.from({ length: Math.min(FALLBACK_PROBE_CONCURRENCY, requests.length) }, worker));
  return out;
}

/** Run a whole-target cache job. Rejects with `cancelled` when aborted, or with the first fatal error. */
export async function runExplainCache(opts: RunExplainCacheOptions): Promise<ExplainCacheResult> {
  const { ai, signal } = opts;
  const chunkSize = Math.max(1, opts.chunkSize ?? BATCH_CHUNK_SIZE);
  const concurrency = Math.max(1, opts.concurrency ?? BATCH_CONCURRENCY);
  const maxRetries = opts.maxRetries ?? 4;
  const backoffMs = opts.backoffMs ?? 2000;
  const sleep = opts.sleep ?? abortableSleep;
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw cancelledError();
  };

  throwIfAborted();
  const unique = dedupeBySentence(opts.requests.filter((r) => r.sentence.trim().length > 0));
  const status = await probeCachedStatus(ai, unique);
  throwIfAborted();
  const pending = unique.filter((_, i) => !status[i]);
  const cachedRequests = unique.filter((_, i) => status[i]);
  opts.onChecked?.({ total: unique.length, cached: cachedRequests.length, cachedRequests });

  const call = async (reqs: readonly ExplainRequest[]): Promise<void> => {
    // `explainBatch` also serves 1-item chunks (hosts route them to a single explain).
    if (ai.explainBatch) {
      await ai.explainBatch(reqs, signal ? { signal } : undefined);
      return;
    }
    for (const r of reqs) {
      throwIfAborted();
      await ai.explain(r, signal ? { signal } : undefined);
    }
  };

  /** Explain one chunk with backoff + split fallback; resolves with what succeeded / failed. */
  const processChunk = async (reqs: readonly ExplainRequest[]): Promise<ChunkOutcome> => {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted();
      try {
        await call(reqs);
        return { ok: reqs, failed: [] };
      } catch (e) {
        if (signal?.aborted) throw cancelledError();
        const code = errorCode(e);
        if (code && FATAL.has(code)) throw e;
        if (isRateLimited(e)) {
          if (attempt < maxRetries) {
            await sleep(backoffMs * 2 ** attempt, signal);
            continue;
          }
          return { ok: [], failed: reqs };
        }
        break;
      }
    }
    if (reqs.length <= 1) return { ok: [], failed: reqs };
    const mid = Math.ceil(reqs.length / 2);
    const left = await processChunk(reqs.slice(0, mid));
    const right = await processChunk(reqs.slice(mid));
    return { ok: [...left.ok, ...right.ok], failed: [...left.failed, ...right.failed] };
  };

  const chunks = chunk(pending, chunkSize);
  let next = 0;
  let completed = 0;
  let failed = 0;
  let fatal: unknown;
  const worker = async (): Promise<void> => {
    while (fatal === undefined && next < chunks.length) {
      if (signal?.aborted) return;
      const reqs = chunks[next++]!;
      opts.onChunkStart?.(reqs);
      let outcome: ChunkOutcome;
      try {
        outcome = await processChunk(reqs);
      } catch (e) {
        opts.onChunkSettled?.(reqs, { ok: [], failed: [] });
        fatal ??= e;
        return;
      }
      completed += outcome.ok.length;
      failed += outcome.failed.length;
      opts.onChunkSettled?.(reqs, outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  if (signal?.aborted) throw cancelledError();
  if (fatal !== undefined) throw fatal;
  return { total: unique.length, cachedInitially: cachedRequests.length, completed, failed };
}
