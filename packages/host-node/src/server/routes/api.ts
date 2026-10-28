/**
 * Generic REST dispatch: mounts every route-table entry of a `PlatformHost`
 * group onto Hono and forwards decoded arguments to `ctx.host[group][method]`.
 * Errors become `{ ok: false, error }` envelopes with mapped HTTP statuses.
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { KotoriError } from '@kotori/core';
import { ROUTES, ROUTE_KEYS, errorEnvelope, httpStatusForCode, okEnvelope, serialiseError, type RoutedMethodKey, type WireRequest } from '../../shared';
import type { ServerContext } from '../context';

export type HostGroupName = 'settings' | 'anime' | 'manga' | 'ai' | 'downloads' | 'files' | 'dict';

/** Methods whose trailing argument is `AiCallOptions` (client disconnect → abort). */
const SIGNAL_METHODS: ReadonlySet<RoutedMethodKey> = new Set(['ai.explain', 'ai.followUp', 'ai.ocrBubble', 'ai.pageGuide']);

/** JSON error response for any thrown value. */
export function errorResponse(c: Context, error: unknown): Response {
  const shape = serialiseError(error);
  if (shape.code === 'internal') console.error('[kotori:server]', error);
  return c.json(errorEnvelope(error), httpStatusForCode(shape.code) as ContentfulStatusCode);
}

/** Read an optional JSON body (empty → `undefined`). */
export async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KotoriError('invalid-argument', 'Request body is not valid JSON');
  }
}

/** Build the transport-neutral request for a route. */
export async function wireRequest(c: Context, method: string): Promise<WireRequest> {
  const params = c.req.param() as Record<string, string>;
  const query = c.req.query();
  const body = method === 'GET' || method === 'DELETE' ? undefined : await readJsonBody(c);
  return body === undefined ? { params, query } : { params, query, body };
}

/** Invoke the host method for a route key with decoded args. */
export async function invoke(ctx: ServerContext, key: RoutedMethodKey, wire: WireRequest, signal?: AbortSignal): Promise<unknown> {
  const route = ROUTES[key];
  let args: unknown[];
  try {
    args = (route.decode as (w: WireRequest) => unknown[])(wire);
  } catch (error) {
    throw new KotoriError('invalid-argument', error instanceof Error ? error.message : String(error));
  }
  const [group, method] = key.split('.') as [HostGroupName, string];
  const target = ctx.host[group] as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>;
  const fn = target[method];
  if (typeof fn !== 'function') throw new KotoriError('unsupported', `${key} is not implemented by this host`);
  if (SIGNAL_METHODS.has(key) && signal) args = [...args, { signal }];
  return fn.apply(target, args);
}

/** Static path segments first so literal routes win over `:param` ones. */
function specificity(path: string): number {
  return path.split('/').filter((s) => s && !s.startsWith(':')).length * 100 - path.split('/').length;
}

/**
 * Mount all routes of `group`. `skip` lists keys a group file mounts itself
 * (e.g. the SSE follow-up stream).
 */
export function mountGroup(app: Hono, ctx: ServerContext, group: HostGroupName, skip: ReadonlySet<RoutedMethodKey> = new Set()): void {
  const keys = ROUTE_KEYS.filter((k) => k.startsWith(`${group}.`) && !skip.has(k)).sort((a, b) => specificity(ROUTES[b].path) - specificity(ROUTES[a].path));
  for (const key of keys) {
    const route = ROUTES[key];
    app.on(route.method, route.path, async (c) => {
      try {
        const wire = await wireRequest(c, route.method);
        const result = await invoke(ctx, key, wire, c.req.raw.signal);
        // `undefined` (void / cache miss) travels as `null`.
        return c.json(okEnvelope(result ?? null));
      } catch (error) {
        return errorResponse(c, error);
      }
    });
  }
}
