/**
 * Single switch from `VertexAuth` to a bearer-token provider, shared by both
 * hosts. Only `adc` needs host help (desktop injects google-auth-library).
 */
import type { VertexAuth } from '../types';
import { KotoriError } from '../util/errors';
import { createServiceAccountTokenProvider } from './service-account';

export interface CredentialDeps {
  /** Host-injected Application Default Credentials token source (desktop only). */
  readonly adc?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Warning sink (default `console.warn` with a `[kotori:ai]` prefix). */
  readonly warn?: (message: string) => void;
}

/**
 * Resolve a token provider for Vertex AI:
 * - `access-token` → static token (warns once when `expiresAt` has passed),
 * - `service-account-json` → `createServiceAccountTokenProvider`,
 * - `adc` → `deps.adc` (`unsupported` error on call when the host lacks it),
 * - `express-api-key` → `undefined` (the key travels in the query string).
 */
export function resolveAccessTokenProvider(auth: VertexAuth, deps: CredentialDeps = {}): (() => Promise<string>) | undefined {
  const now = deps.now ?? (() => Date.now());
  const warn = deps.warn ?? ((m: string) => console.warn(`[kotori:ai] ${m}`));
  switch (auth.kind) {
    case 'access-token': {
      let warned = false;
      return async () => {
        if (!auth.accessToken) throw new KotoriError('ai-auth', 'Vertex access token is empty');
        if (!warned && auth.expiresAt !== undefined && now() >= auth.expiresAt) {
          warned = true;
          warn('Vertex access token has expired; requests will likely fail with ai-auth. Paste a fresh token.');
        }
        return auth.accessToken;
      };
    }
    case 'service-account-json':
      return createServiceAccountTokenProvider(auth.json, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
    case 'adc': {
      const adc = deps.adc;
      if (adc) return adc;
      return async () => {
        throw new KotoriError('unsupported', 'Application Default Credentials are not available on this host');
      };
    }
    case 'express-api-key':
      return undefined;
  }
}
