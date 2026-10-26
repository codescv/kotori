/**
 * Clock formatting helpers.
 */

/**
 * Format milliseconds as `m:ss` (< 1 h) or `h:mm:ss`. Negative / non-finite
 * values clamp to `0:00`. With `withMillis`, appends `.mmm`.
 */
export function formatClock(ms: number, opts: { withMillis?: boolean } = {}): string {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  return opts.withMillis ? `${base}.${String(safe % 1000).padStart(3, '0')}` : base;
}

/**
 * Parse `h:mm:ss(.mmm|,mmm)`, `mm:ss(.mmm)` or `ss(.mmm)` into milliseconds.
 * Returns `undefined` for malformed input.
 */
export function parseClock(text: string): number | undefined {
  const m = /^\s*(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (!m) return undefined;
  // With two optional groups the regex fills the first one first; normalise.
  const parts = [m[1], m[2]].filter((p): p is string => p !== undefined);
  const hours = parts.length === 2 ? Number(parts[0]) : 0;
  const minutes = parts.length === 2 ? Number(parts[1]) : parts.length === 1 ? Number(parts[0]) : 0;
  const seconds = Number(m[3]);
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + frac;
}
