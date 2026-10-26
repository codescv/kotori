/**
 * Series title / volume number extraction from manga file or folder names.
 */

/** Result of {@link parseVolumeName}. */
export interface ParsedVolumeName {
  readonly seriesTitle: string;
  readonly volumeNumber?: number;
}

const ARCHIVE_EXT = /\.(?:mokuro|cbz|zip|cbr|rar|cb7|7z|pdf|epub|json)$/i;
const KANJI_DIGITS: Readonly<Record<string, number>> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** Map full-width digits / dot to ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * Parse an Arabic (`3`, `03`, `10.5`) or simple kanji (`三`, `十二`, `二十五`,
 * up to 99) numeral; `undefined` if unparsable.
 */
function parseNumber(token: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
  if (!/^[〇零一二三四五六七八九十]+$/.test(token)) return undefined;
  const ten = token.indexOf('十');
  if (ten === -1) return token.length === 1 ? KANJI_DIGITS[token] : undefined;
  if (token.indexOf('十', ten + 1) !== -1) return undefined;
  const tensPart = token.slice(0, ten);
  const onesPart = token.slice(ten + 1);
  const tens = tensPart === '' ? 1 : tensPart.length === 1 ? KANJI_DIGITS[tensPart] : undefined;
  const ones = onesPart === '' ? 0 : onesPart.length === 1 ? KANJI_DIGITS[onesPart] : undefined;
  return tens === undefined || ones === undefined ? undefined : tens * 10 + ones;
}

// Ordered by specificity; each has one capture group holding the number.
const VOLUME_PATTERNS: readonly RegExp[] = [
  /第\s*([\d.]+|[〇零一二三四五六七八九十]+)\s*[巻卷集冊册]/,
  /(?<![\p{L}\p{N}])([\d.]+)\s*[巻卷冊册]/u,
  /(?<![\p{L}\p{N}])vol(?:ume)?\s*[.:]?\s*[-_]?\s*(\d+(?:\.\d+)?)/iu,
  /(?<![\p{L}\p{N}])v\s*(\d+(?:\.\d+)?)(?![\p{L}])/iu,
  /(?<![\p{L}\p{N}.])(\d{1,4}(?:\.\d+)?)\s*$/u,
];

/** Tidy a leftover title: underscores → spaces, drop empty brackets & edge separators. */
function cleanTitle(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/[([{【「（]\s*[)\]}】」）]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—.,:;~#]+|[\s\-–—.,:;~#]+$/g, '')
    .trim();
}

/**
 * Split a manga file/folder name into series title and volume number.
 * Handles `第3巻` / `第三巻` / `3巻`, `v03`, `Vol. 3` / `Volume 3`, and a trailing
 * bare number (`Title 03`). Directory components and archive extensions
 * (`.mokuro`, `.cbz`, `.zip` …) are stripped; full-width digits are accepted.
 * When nothing is left for the title, the cleaned name is used.
 */
export function parseVolumeName(name: string): ParsedVolumeName {
  const base = name.replace(/\\/g, '/').replace(/\/+$/, '');
  const stem = base.slice(base.lastIndexOf('/') + 1).replace(ARCHIVE_EXT, '');
  const normalised = asciiDigits(stem);
  for (const pattern of VOLUME_PATTERNS) {
    const m = pattern.exec(normalised);
    const token = m?.[1];
    if (!m || token === undefined) continue;
    const volumeNumber = parseNumber(token);
    if (volumeNumber === undefined || !Number.isFinite(volumeNumber)) continue;
    // Drop the token plus any separator run (` - `, `_`) right before it.
    const before = normalised.slice(0, m.index).replace(/[\s\-–—_~.,:#]+$/, '');
    const rest = before + ' ' + normalised.slice(m.index + m[0].length);
    const seriesTitle = cleanTitle(rest) || cleanTitle(normalised);
    return { seriesTitle, volumeNumber };
  }
  return { seriesTitle: cleanTitle(normalised) || stem };
}
