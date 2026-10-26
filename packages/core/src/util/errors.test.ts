import { describe, expect, it } from 'vitest';
import { KotoriError, isKotoriError } from './errors';

describe('KotoriError', () => {
  it('round-trips through the wire shape', () => {
    const original = new KotoriError('ai-quota', 'quota exceeded', { details: { status: 429 } });
    const shape = original.toShape();
    expect(shape).toEqual({ code: 'ai-quota', message: 'quota exceeded', details: { status: 429 } });
    const rebuilt = KotoriError.fromShape(JSON.parse(JSON.stringify(shape)));
    expect(isKotoriError(rebuilt)).toBe(true);
    expect(rebuilt.code).toBe('ai-quota');
    expect(rebuilt.details).toEqual({ status: 429 });
  });

  it('omits details when absent', () => {
    expect(new KotoriError('not-found', 'nope').toShape()).toEqual({ code: 'not-found', message: 'nope' });
  });

  it('wraps unknown errors as internal', () => {
    const wrapped = KotoriError.wrap(new TypeError('boom'));
    expect(wrapped.code).toBe('internal');
    expect(wrapped.message).toBe('boom');
    expect(KotoriError.wrap('str', 'parse').code).toBe('parse');
  });
});
