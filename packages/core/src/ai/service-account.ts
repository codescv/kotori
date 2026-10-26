/**
 * Platform-neutral Google service-account auth: RS256 JWT signed with
 * WebCrypto (`crypto.subtle`) and exchanged for an OAuth2 access token at the
 * key's `token_uri`. Works identically on desktop and in the Android WebView.
 */
import { KotoriError } from '../util/errors';

export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Refresh this long before the token's reported expiry. */
const REFRESH_SKEW_MS = 60_000;

export interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
  readonly projectId?: string;
  readonly privateKeyId?: string;
}

export interface ServiceAccountDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Override the OAuth scope (default cloud-platform). */
  readonly scope?: string;
}

/**
 * Parse and validate a service-account JSON key file. Throws `ai-auth` when
 * the JSON is malformed or lacks `client_email` / `private_key`.
 */
export function parseServiceAccountJson(json: string): ServiceAccountKey {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new KotoriError('ai-auth', 'Service account JSON is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new KotoriError('ai-auth', 'Service account JSON must be an object');
  const r = raw as Record<string, unknown>;
  if (r['type'] !== undefined && r['type'] !== 'service_account') {
    throw new KotoriError('ai-auth', `Expected a service_account key, got type '${String(r['type'])}'`);
  }
  const clientEmail = r['client_email'];
  const privateKey = r['private_key'];
  if (typeof clientEmail !== 'string' || !clientEmail) throw new KotoriError('ai-auth', 'Service account JSON is missing client_email');
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) throw new KotoriError('ai-auth', 'Service account JSON is missing private_key');
  const key: { clientEmail: string; privateKey: string; tokenUri: string; projectId?: string; privateKeyId?: string } = {
    clientEmail,
    privateKey,
    tokenUri: typeof r['token_uri'] === 'string' && r['token_uri'] ? r['token_uri'] : DEFAULT_TOKEN_URI,
  };
  if (typeof r['project_id'] === 'string') key.projectId = r['project_id'];
  if (typeof r['private_key_id'] === 'string') key.privateKeyId = r['private_key_id'];
  return key;
}

/** Base64url-encode bytes (no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64url-encode a UTF-8 string. */
function b64urlString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

/** Decode a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`) into DER bytes. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  let bin: string;
  try {
    bin = atob(body);
  } catch {
    throw new KotoriError('ai-auth', 'Service account private_key is not valid base64 PEM');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Build and sign the RS256 JWT assertion for the token exchange.
 * `nowMs` is epoch ms; `iat`/`exp` are seconds.
 */
export async function signServiceAccountJwt(key: ServiceAccountKey, nowMs: number, scope: string = CLOUD_PLATFORM_SCOPE): Promise<string> {
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      pemToDer(key.privateKey) as Uint8Array<ArrayBuffer>,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (e) {
    throw KotoriError.wrap(e instanceof KotoriError ? e : new Error(`Cannot import service account private key: ${String(e)}`), 'ai-auth');
  }
  const iat = Math.floor(nowMs / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.privateKeyId) header['kid'] = key.privateKeyId;
  const payload = { iss: key.clientEmail, scope, aud: key.tokenUri, iat, exp: iat + 3600 };
  const signingInput = `${b64urlString(JSON.stringify(header))}.${b64urlString(JSON.stringify(payload))}`;
  const sig = await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/**
 * Create a cached access-token provider for a service-account key. Tokens are
 * reused until 60 s before `expires_in`; concurrent callers share one
 * in-flight exchange. All failures reject with `ai-auth` (or `network` when
 * the token endpoint is unreachable).
 */
export function createServiceAccountTokenProvider(json: string, deps: ServiceAccountDeps = {}): () => Promise<string> {
  const key = parseServiceAccountJson(json);
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const now = deps.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  /** Perform one JWT-bearer token exchange. */
  async function exchange(): Promise<string> {
    const issuedAt = now();
    const assertion = await signServiceAccountJwt(key, issuedAt, deps.scope);
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
    let res: Response;
    try {
      res = await doFetch(key.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    } catch (e) {
      throw new KotoriError('network', `Token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new KotoriError('ai-auth', `Service account token exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`, { details: { status: res.status } });
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new KotoriError('ai-auth', 'Token endpoint returned non-JSON');
    }
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new KotoriError('ai-auth', 'Token endpoint returned no access_token');
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : Number(parsed.expires_in ?? 3600) || 3600;
    cached = { token: parsed.access_token, expiresAt: issuedAt + expiresIn * 1000 };
    return parsed.access_token;
  }

  return async () => {
    if (cached && now() < cached.expiresAt - REFRESH_SKEW_MS) return cached.token;
    if (!inflight) {
      inflight = exchange().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };
}
