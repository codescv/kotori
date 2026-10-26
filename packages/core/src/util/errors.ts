import type { KotoriErrorCode, KotoriErrorShape } from '../types';

/**
 * Error type thrown across every Kotori boundary. Hosts serialise it with
 * `toShape()`; the REST client / Capacitor bridge rebuild it with `fromShape()`
 * so the UI can switch on `error.code` regardless of platform.
 */
export class KotoriError extends Error implements KotoriErrorShape {
  readonly code: KotoriErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: KotoriErrorCode, message: string, options?: { details?: Record<string, unknown>; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KotoriError';
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
  }

  toShape(): KotoriErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static fromShape(shape: KotoriErrorShape): KotoriError {
    return new KotoriError(shape.code, shape.message, shape.details === undefined ? undefined : { details: { ...shape.details } });
  }

  /** Narrow any thrown value to a `KotoriError` (wrapping unknowns as `internal`). */
  static wrap(error: unknown, fallbackCode: KotoriErrorCode = 'internal'): KotoriError {
    if (error instanceof KotoriError) return error;
    if (error instanceof Error) return new KotoriError(fallbackCode, error.message, { cause: error });
    return new KotoriError(fallbackCode, String(error));
  }
}

export function isKotoriError(value: unknown): value is KotoriError {
  return value instanceof KotoriError;
}
