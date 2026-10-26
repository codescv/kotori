/**
 * Natural ("human") string ordering: digit runs compare numerically, the rest
 * case-insensitively, so `p2.jpg < p10.jpg` and `Vol 9 < Vol 10`. Full-width
 * digits are treated like ASCII digits.
 */

const CHUNK = /(\d+)|(\D+)/g;

/** Map full-width digits `０-９` to ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

/** Split into alternating digit / non-digit chunks. */
function chunks(s: string): string[] {
  return asciiDigits(s).match(CHUNK) ?? [];
}

/**
 * Comparator for `Array.prototype.sort`. Ties broken by plain code-unit order
 * so the result is total and deterministic.
 */
export function compareNatural(a: string, b: string): number {
  const ca = chunks(a);
  const cb = chunks(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i] as string;
    const y = cb[i] as string;
    const xd = /^\d/.test(x);
    const yd = /^\d/.test(y);
    if (xd && yd) {
      // Compare by numeric value without overflow: strip leading zeros, then length, then lexicographic.
      const xs = x.replace(/^0+(?=\d)/, '');
      const ys = y.replace(/^0+(?=\d)/, '');
      if (xs.length !== ys.length) return xs.length - ys.length;
      if (xs !== ys) return xs < ys ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    } else if (xd !== yd) {
      return xd ? -1 : 1;
    } else {
      const xl = x.toLowerCase();
      const yl = y.toLowerCase();
      if (xl !== yl) return xl < yl ? -1 : 1;
    }
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
