/**
 * Contract shared by the Node server and the browser REST client. Browser-safe
 * (no `node:*` imports). Owner: coder-2.
 *
 *   - routes.ts  `API_PREFIX`, typed route table (method + path + codec) for
 *                every `PlatformHost` method, SSE path for `HostEvent`s,
 *                `/media/:episodeId` (Range stream), manga page images.
 *   - wire.ts    JSON envelope `{ ok: true, data } | { ok: false, error }`,
 *                `serialiseError()`, `deserialiseError()`, HTTP status mapping.
 */
export * from './routes';
export * from './wire';
