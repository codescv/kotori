/**
 * JSON wire envelope shared by the Node server and the browser REST client.
 * Browser-safe: no `node:*` imports.
 *
 * Success: `{ ok: true, data }`; failure: `{ ok: false, error: KotoriErrorShape }`.
 * HTTP status codes are derived from the error code so that generic HTTP
 * tooling (curl, devtools) shows meaningful statuses.
 */
import { KotoriError } from '@kotori/core';
import type { KotoriErrorCode, KotoriErrorShape } from '@kotori/core';

export type ApiEnvelope<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: KotoriErrorShape };

const STATUS_BY_CODE: Readonly<Partial<Record<KotoriErrorCode, number>>> = {
  'not-found': 404,
  'invalid-argument': 400,
  parse: 400,
  unsupported: 501,
  'ai-auth': 401,
  'ai-quota': 429,
  cancelled: 499,
  'ai-timeout': 504,
  network: 502,
};

const ALL_CODES: ReadonlySet<string> = new Set<KotoriErrorCode>([
  'not-found',
  'invalid-argument',
  'unsupported',
  'io',
  'network',
  'parse',
  'ai-auth',
  'ai-quota',
  'ai-safety',
  'ai-invalid-response',
  'ai-timeout',
  'cancelled',
  'internal',
]);

/** HTTP status for an error code (`not-found`→404, `invalid-argument`→400, … else 500). */
export function httpStatusForCode(code: KotoriErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Best-effort error code for a bare HTTP status (used when the body is not an envelope). */
export function codeForHttpStatus(status: number): KotoriErrorCode {
  if (status === 404) return 'not-found';
  if (status === 400 || status === 422) return 'invalid-argument';
  if (status === 401 || status === 403) return 'ai-auth';
  if (status === 429) return 'ai-quota';
  if (status === 501) return 'unsupported';
  if (status === 504) return 'ai-timeout';
  if (status === 499) return 'cancelled';
  return 'internal';
}

export function isKotoriErrorCode(value: unknown): value is KotoriErrorCode {
  return typeof value === 'string' && ALL_CODES.has(value);
}

/** Convert any thrown value to a serialisable shape (unknown errors → `internal`). */
export function serialiseError(error: unknown): KotoriErrorShape {
  if (error instanceof KotoriError) return error.toShape();
  if (isErrorShapeLike(error)) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return { code: 'cancelled', message: error.message || 'Aborted' };
    return { code: 'internal', message: error.message };
  }
  return { code: 'internal', message: String(error) };
}

/** Rebuild a `KotoriError` from a wire shape. */
export function deserialiseError(shape: KotoriErrorShape): KotoriError {
  return KotoriError.fromShape(shape);
}

export function okEnvelope<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data };
}

export function errorEnvelope(error: unknown): ApiEnvelope<never> {
  return { ok: false, error: serialiseError(error) };
}

function isErrorShapeLike(value: unknown): value is KotoriErrorShape {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { code?: unknown; message?: unknown };
  return isKotoriErrorCode(v.code) && typeof v.message === 'string';
}

/** Type guard for a decoded JSON envelope. */
export function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; error?: unknown };
  if (v.ok === true) return 'data' in v;
  if (v.ok === false) return isErrorShapeLike(v.error);
  return false;
}
