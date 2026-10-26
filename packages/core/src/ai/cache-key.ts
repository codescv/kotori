/**
 * Explanation cache keys = hash(sentence, targetLanguage, model, promptVersion).
 */
import type { TargetLanguage } from '../types';
import { fnv1a64, hasSubtleCrypto, sha256Hex } from '../util/hash';

export interface ExplanationKeyInput {
  readonly sentence: string;
  readonly targetLanguage: TargetLanguage;
  readonly model: string;
  readonly promptVersion: string;
}

/** Canonical, unambiguous serialisation of the key fields. */
function canonical(input: ExplanationKeyInput): string {
  return JSON.stringify([input.promptVersion, input.model, input.targetLanguage, input.sentence]);
}

/**
 * Stable cache key `ex_<sha256 hex>` (64 hex chars). Falls back to the
 * synchronous `ex_<fnv1a64>` (16 hex chars) when `crypto.subtle` is missing.
 */
export async function explanationCacheKey(input: ExplanationKeyInput): Promise<string> {
  if (!hasSubtleCrypto()) return explanationCacheKeySync(input);
  return `ex_${await sha256Hex(canonical(input))}`;
}

/** Synchronous fallback key `ex_<fnv1a64 hex>` (tests / no WebCrypto). */
export function explanationCacheKeySync(input: ExplanationKeyInput): string {
  return `ex_${fnv1a64(canonical(input))}`;
}
