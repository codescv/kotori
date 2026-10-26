/**
 * Hash helpers (platform-neutral).
 *
 * - `sha256Hex` uses WebCrypto `crypto.subtle` (browsers, Node 22+, Android WebView).
 * - `fnv1a64` is a pure, synchronous 64-bit FNV-1a used as a fallback when
 *   `crypto.subtle` is unavailable (e.g. insecure WebView origins) and for
 *   cheap non-cryptographic ids.
 */

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** UTF-8 encode a string (shared encoder instance). */
const encoder = new TextEncoder();

/** Hex-encode bytes, lower-case. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Whether WebCrypto `subtle.digest` is available in this runtime. */
export function hasSubtleCrypto(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle?.digest === 'function';
}

/**
 * SHA-256 of `input` (string → UTF-8, or raw bytes), lower-case hex.
 * Rejects with the underlying error when `crypto.subtle` is missing.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * 64-bit FNV-1a over the UTF-8 bytes of `input`, as a 16-char lower-case hex
 * string. Synchronous and deterministic across platforms.
 */
export function fnv1a64(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let hash = FNV_OFFSET_64;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}
