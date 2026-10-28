/**
 * Local-only request guard (first middleware). The server is an
 * unauthenticated tool bound to loopback, so it must not be drivable by
 * other websites:
 *
 * 1. **DNS rebinding** — reject any request whose `Host` is not a loopback
 *   name (`127.0.0.1`, `localhost`, `[::1]`) or the explicitly configured
 *   `--host` → 403.
 * 2. **CSRF** — for state-changing methods, a present `Origin` must be
 *   same-origin with the request (browsers always send `Origin` on
 *   cross-origin POSTs) → 403; and a request body must be
 *   `application/json` (multipart only on the subtitle upload route; raw
 *   `application/zip` / `application/octet-stream` only on the dictionary
 *   upload route — both non-simple types that also force a preflight), which
 *   forces a CORS preflight we never answer → 415.
 */
import type { MiddlewareHandler } from 'hono';
import type { ServerOptions } from './index';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MULTIPART_ROUTE = /^\/api\/anime\/episodes\/[^/]+\/tracks$/;
const BINARY_UPLOAD_ROUTE = /^\/api\/dict\/import$/;
const BINARY_TYPES = new Set(['application/zip', 'application/octet-stream', 'application/x-zip-compressed']);

function forbidden(message: string, status: 403 | 415): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: 'invalid-argument', message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Hostnames accepted in `Host` (loopback + a non-wildcard `--host`). */
export function allowedHostnames(options: Pick<ServerOptions, 'host'>): Set<string> {
  const allowed = new Set(LOOPBACK);
  const configured = options.host.toLowerCase();
  if (configured && configured !== '0.0.0.0' && configured !== '::') allowed.add(configured.includes(':') && !configured.startsWith('[') ? `[${configured}]` : configured);
  return allowed;
}

export function localOnlyGuard(options: Pick<ServerOptions, 'host'>): MiddlewareHandler {
  const allowed = allowedHostnames(options);
  return async (c, next) => {
    const url = new URL(c.req.url);
    const hostHeader = c.req.header('host') ?? url.host;
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      return forbidden('Invalid Host header', 403);
    }
    if (!allowed.has(hostname)) return forbidden(`Host ${hostname} is not allowed (Kotori only serves 127.0.0.1 / localhost)`, 403);

    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        let originHost: string | undefined;
        try {
          originHost = origin === 'null' ? undefined : new URL(origin).host.toLowerCase();
        } catch {
          originHost = undefined;
        }
        if (originHost !== hostHeader.toLowerCase()) return forbidden(`Cross-origin request from ${origin} rejected`, 403);
      }
      const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const length = Number(c.req.header('content-length') ?? '0');
      const hasBody = contentType !== '' || length > 0 || c.req.header('transfer-encoding') !== undefined;
      const json = contentType === 'application/json';
      const multipart = contentType === 'multipart/form-data' && MULTIPART_ROUTE.test(url.pathname);
      const binary = BINARY_TYPES.has(contentType) && BINARY_UPLOAD_ROUTE.test(url.pathname);
      if (hasBody && !json && !multipart && !binary) return forbidden('Request body must be application/json', 415);
    }
    await next();
  };
}
