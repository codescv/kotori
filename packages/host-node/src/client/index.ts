/**
 * Browser-side `PlatformHost` implementation that talks to the local Kotori
 * server over REST + SSE. Browser-safe (no `node:*` imports). Owner: coder-2.
 *
 * Planned modules:
 *   - rest-host.ts     `createRestPlatformHost({ baseUrl }): PlatformHost`
 *   - http.ts          fetch wrapper: envelope decoding → KotoriError, AbortSignal timeouts
 *   - events.ts        EventSource subscription with reconnect → `HostEvent` fan-out
 */
import type { PlatformHost } from '@kotori/core';

export interface RestPlatformHostOptions {
  /** Origin of the Kotori server; defaults to `window.location.origin`. */
  readonly baseUrl?: string;
}

export type CreateRestPlatformHost = (options?: RestPlatformHostOptions) => PlatformHost;
