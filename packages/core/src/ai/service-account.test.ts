import { describe, expect, it } from 'vitest';
import { KotoriError } from '../util/errors';
import { resolveAccessTokenProvider } from './credentials';
import { base64UrlEncode, createServiceAccountTokenProvider, parseServiceAccountJson, pemToDer, signServiceAccountJwt } from './service-account';

/** Generate an RSA key pair and a matching service-account JSON. */
async function makeKey(): Promise<{ json: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, '$1\n');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({
    type: 'service_account',
    project_id: 'proj',
    private_key_id: 'kid1',
    private_key: pem,
    client_email: 'sa@proj.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.example/token',
  });
  return { json, publicKey: pair.publicKey };
}

const keyPromise = makeKey();

/** Decode a base64url segment to a UTF-8 string. */
function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe('parseServiceAccountJson', () => {
  it('parses a valid key', async () => {
    const { json } = await keyPromise;
    expect(parseServiceAccountJson(json)).toMatchObject({ clientEmail: 'sa@proj.iam.gserviceaccount.com', tokenUri: 'https://oauth2.example/token', projectId: 'proj', privateKeyId: 'kid1' });
  });
  it('defaults token_uri and rejects bad input with ai-auth', () => {
    expect(parseServiceAccountJson(JSON.stringify({ client_email: 'a', private_key: '-----BEGIN PRIVATE KEY-----x' })).tokenUri).toBe('https://oauth2.googleapis.com/token');
    for (const bad of ['nope', '1', '{}', JSON.stringify({ type: 'authorized_user', client_email: 'a', private_key: 'PRIVATE KEY' }), JSON.stringify({ client_email: 'a' })]) {
      expect(() => parseServiceAccountJson(bad)).toThrow(expect.objectContaining({ code: 'ai-auth' }));
    }
  });
});

describe('helpers', () => {
  it('base64UrlEncode / pemToDer', () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect([...pemToDer('-----BEGIN PRIVATE KEY-----\\nAQID\\n-----END PRIVATE KEY-----')]).toEqual([1, 2, 3]);
    expect(() => pemToDer('-----BEGIN PRIVATE KEY-----\n@@@\n-----END PRIVATE KEY-----')).toThrow(KotoriError);
  });
});

describe('signServiceAccountJwt', () => {
  it('produces a verifiable RS256 JWT with the expected claims', async () => {
    const { json, publicKey } = await keyPromise;
    const jwt = await signServiceAccountJwt(parseServiceAccountJson(json), 1_700_000_000_500);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid1' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(p)))).toEqual({
      iss: 'sa@proj.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.example/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(s) as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });
  it('rejects an unusable private key with ai-auth', async () => {
    await expect(signServiceAccountJwt({ clientEmail: 'a', privateKey: '-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----', tokenUri: 'x' }, 0)).rejects.toMatchObject({ code: 'ai-auth' });
  });
});

describe('createServiceAccountTokenProvider', () => {
  it('exchanges, caches, refreshes 60 s early and coalesces concurrent calls', async () => {
    const { json } = await keyPromise;
    let now = 1_000_000;
    const bodies: string[] = [];
    let n = 0;
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://oauth2.example/token');
      expect((init?.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
      bodies.push(String(init?.body));
      n++;
      return new Response(JSON.stringify({ access_token: `tok${n}`, expires_in: 3600, token_type: 'Bearer' }));
    }) as typeof fetch;
    const provider = createServiceAccountTokenProvider(json, { fetch: fetchFn, now: () => now });
    const [a, b] = await Promise.all([provider(), provider()]);
    expect([a, b]).toEqual(['tok1', 'tok1']);
    expect(n).toBe(1);
    const params = new URLSearchParams(bodies[0]);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')?.split('.')).toHaveLength(3);
    now += 3_600_000 - 61_000;
    expect(await provider()).toBe('tok1');
    now += 2_000; // within 60 s of expiry
    expect(await provider()).toBe('tok2');
    expect(n).toBe(2);
  });

  it('maps token endpoint failures', async () => {
    const { json } = await keyPromise;
    const denied = createServiceAccountTokenProvider(json, { fetch: (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch });
    await expect(denied()).rejects.toMatchObject({ code: 'ai-auth' });
    const noToken = createServiceAccountTokenProvider(json, { fetch: (async () => new Response('{}')) as typeof fetch });
    await expect(noToken()).rejects.toMatchObject({ code: 'ai-auth' });
    const offline = createServiceAccountTokenProvider(json, { fetch: (async () => Promise.reject(new TypeError('offline'))) as typeof fetch });
    await expect(offline()).rejects.toMatchObject({ code: 'network' });
  });

  it('throws ai-auth synchronously for malformed JSON', () => {
    expect(() => createServiceAccountTokenProvider('{')).toThrow(expect.objectContaining({ code: 'ai-auth' }));
  });
});

describe('resolveAccessTokenProvider', () => {
  it('returns a static provider for access-token and warns once when expired', async () => {
    const warnings: string[] = [];
    const p = resolveAccessTokenProvider({ kind: 'access-token', accessToken: 't', expiresAt: 10 }, { now: () => 20, warn: (m) => warnings.push(m) });
    expect(await p?.()).toBe('t');
    expect(await p?.()).toBe('t');
    expect(warnings).toHaveLength(1);
    const empty = resolveAccessTokenProvider({ kind: 'access-token', accessToken: '' });
    await expect(empty?.()).rejects.toMatchObject({ code: 'ai-auth' });
  });
  it('uses deps.adc or rejects unsupported', async () => {
    expect(await resolveAccessTokenProvider({ kind: 'adc' }, { adc: async () => 'adc' })?.()).toBe('adc');
    await expect(resolveAccessTokenProvider({ kind: 'adc' })?.()).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('returns undefined for express keys and a SA provider for SA JSON', async () => {
    expect(resolveAccessTokenProvider({ kind: 'express-api-key', apiKey: 'k' })).toBeUndefined();
    const { json } = await keyPromise;
    const p = resolveAccessTokenProvider({ kind: 'service-account-json', json }, { fetch: (async () => new Response('{"access_token":"sa","expires_in":3600}')) as typeof fetch });
    expect(await p?.()).toBe('sa');
  });
});
