/**
 * Minimal `fetch` wrapper for the REST host: builds requests from the shared
 * route table, decodes the JSON envelope, rebuilds `KotoriError`s and maps
 * `AbortSignal`s / timeouts to `cancelled`. Browser-safe.
 */
import { KotoriError } from '@kotori/core';
import {
  ROUTES,
  buildPath,
  buildQuery,
  codeForHttpStatus,
  deserialiseError,
  isApiEnvelope,
  type HostResult,
  type RoutedMethodKey,
  type WireArgs,
  type WireRequest,
} from '../shared';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Origin (or prefix) of the server, no trailing slash. Empty string = same origin. */
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /** Default per-request timeout (non-AI calls); `0` disables. */
  readonly timeoutMs?: number;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  /** Override the default timeout (`0` = none, used for AI calls with their own timeouts). */
  readonly timeoutMs?: number;
}

export interface HttpClient {
  readonly baseUrl: string;
  /** Invoke a routed `PlatformHost` method and return its decoded result. */
  call<K extends RoutedMethodKey>(key: K, args: WireArgs<K>, options?: CallOptions): Promise<HostResult<K>>;
  /** Raw request for a routed method (used for SSE streaming responses). */
  request<K extends RoutedMethodKey>(key: K, args: WireArgs<K>, options?: CallOptions): Promise<Response>;
  /** GET a JSON envelope from an arbitrary path (e.g. `/api/info`). */
  getJson<T>(path: string, options?: CallOptions): Promise<T>;
  /** POST raw bytes (e.g. a dictionary `.zip`) and decode the JSON envelope. */
  postBytes<T>(path: string, bytes: Uint8Array, contentType: string, options?: CallOptions): Promise<T>;
}

/** Combine a caller signal with a timeout; returns the signal and a disposer. */
function linkSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal | undefined; dispose: () => void; timedOut: () => boolean } {
  if (!signal && timeoutMs <= 0) return { signal: undefined, dispose: () => undefined, timedOut: () => false };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error('timeout'));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
    timedOut: () => didTimeout,
  };
}

/** Decode a `Response` carrying a JSON envelope; throws `KotoriError` on failure. */
export async function decodeEnvelope<T>(res: Response): Promise<T> {
  let payload: unknown;
  const text = await res.text();
  try {
    payload = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    throw new KotoriError(codeForHttpStatus(res.status), `HTTP ${res.status}: ${text.slice(0, 200)}`, { details: { status: res.status } });
  }
  if (isApiEnvelope(payload)) {
    if (payload.ok) {
      // Contract: methods never return `null`; `undefined` travels as `null`.
      return (payload.data === null ? undefined : payload.data) as T;
    }
    throw deserialiseError(payload.error);
  }
  if (!res.ok) {
    throw new KotoriError(codeForHttpStatus(res.status), `HTTP ${res.status}`, { details: { status: res.status } });
  }
  throw new KotoriError('internal', 'Malformed response envelope');
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const defaultTimeout = options.timeoutMs ?? 0;

  async function send(method: string, url: string, body: unknown, callOptions: CallOptions | undefined, raw?: { bytes: Uint8Array; contentType: string }): Promise<Response> {
    const link = linkSignal(callOptions?.signal, callOptions?.timeoutMs ?? defaultTimeout);
    const init: RequestInit = { method, headers: { accept: 'application/json' } };
    if (raw) {
      init.body = raw.bytes as unknown as BodyInit;
      init.headers = { accept: 'application/json', 'content-type': raw.contentType };
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { accept: 'application/json', 'content-type': 'application/json' };
    }
    if (link.signal) init.signal = link.signal;
    try {
      return await options.fetch(url, init);
    } catch (error) {
      if (link.timedOut()) throw new KotoriError('network', `Request timed out: ${method} ${url}`);
      if (callOptions?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new KotoriError('cancelled', 'Request cancelled');
      }
      throw new KotoriError('network', error instanceof Error ? error.message : String(error), { cause: error });
    } finally {
      link.dispose();
    }
  }

  function urlFor(key: RoutedMethodKey, wire: WireRequest): string {
    const route = ROUTES[key];
    return baseUrl + buildPath(route.path, wire.params) + buildQuery(wire.query);
  }

  const client: HttpClient = {
    baseUrl,
    async request(key, args, callOptions) {
      const route = ROUTES[key];
      const encode = route.encode as (...a: unknown[]) => WireRequest;
      const wire = encode(...(args as unknown[]));
      return send(route.method, urlFor(key, wire), wire.body, callOptions);
    },
    async call(key, args, callOptions) {
      const res = await client.request(key, args, callOptions);
      try {
        return await decodeEnvelope(res);
      } catch (error) {
        if (callOptions?.signal?.aborted) throw new KotoriError('cancelled', 'Request cancelled');
        throw error;
      }
    },
    async getJson(path, callOptions) {
      const res = await send('GET', baseUrl + path, undefined, callOptions);
      return decodeEnvelope(res);
    },
    async postBytes(path, bytes, contentType, callOptions) {
      const res = await send('POST', baseUrl + path, undefined, callOptions, { bytes, contentType });
      return decodeEnvelope(res);
    },
  };
  return client;
}
