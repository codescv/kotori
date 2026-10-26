/**
 * Browser-side `PlatformHost` implementation that talks to the local Kotori
 * server over REST + SSE. Browser-safe (no `node:*` imports). Owner: coder-2.
 *
 *   - rest-host.ts     `createRestPlatformHost({ baseUrl })`, `connectRestPlatformHost()`
 *   - http.ts          fetch wrapper: envelope decoding → KotoriError, AbortSignal timeouts
 *   - events.ts        SSE subscription with reconnect → `HostEvent` fan-out
 */
export * from './rest-host';
export * from './http';
export * from './events';
