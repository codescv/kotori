/**
 * Contract shared by the Node server and the browser REST client. Browser-safe
 * (no `node:*` imports). Owner: coder-2.
 *
 * Planned modules:
 *   - routes.ts  `API_PREFIX`, typed route table (method + path template) for
 *                every `PlatformHost` method, SSE path for `HostEvent`s,
 *                `/media/:episodeId` (Range stream), `/manga/:volumeId/page/:index`.
 *   - wire.ts    JSON envelope `{ ok: true, data } | { ok: false, error: KotoriErrorShape }`,
 *                `serialiseError()`, `deserialiseError()`.
 */
export const API_PREFIX = '/api' as const;
export const EVENTS_PATH = `${API_PREFIX}/events` as const;

export type ApiEnvelope<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: import('@kotori/core').KotoriErrorShape };
