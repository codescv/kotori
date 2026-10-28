/**
 * Release-style file name parser.
 *
 * Understands the common fansub / scene / Japanese naming conventions:
 *
 * - `[Group] Title - 01v2 (1080p) [ABCD1234].mkv`
 * - `Title.S01E02.1080p.WEB-DL.x264-GRP.mkv`
 * - `タイトル 第01話「サブタイトル」.mp4`
 * - `[Group][Title][01][1080p].mp4` (bracket-only style)
 * - batches `Title 01-12`, `Title (01~12)`, `[Group] Title [BD 1080p HEVC FLAC]`
 *
 * Everything here is heuristic and **never throws**: worst case the title is
 * the bare file name without its extension.
 */
import type { ParsedEpisodeName } from '../types';

/** Extensions stripped from the end of a name (media, subtitles, archives, torrents). */
const MEDIA_EXTENSIONS = new Set([
  'mkv', 'mp4', 'm4v', 'avi', 'webm', 'mov', 'wmv', 'flv', 'ts', 'm2ts', 'mpg', 'mpeg', 'ogm', 'rmvb',
  'mka', 'flac', 'mp3', 'aac', 'opus',
  'ass', 'ssa', 'srt', 'vtt', 'sub', 'idx', 'sup',
  'zip', 'rar', '7z', 'torrent',
]);

const SUBTITLE_EXTENSIONS = new Set(['ass', 'ssa', 'srt', 'vtt', 'sub', 'idx', 'sup']);

/** Language / flavour suffixes that sit between a subtitle name and its extension (`.ja.ass`). */
const SUBTITLE_SUFFIX =
  /\.(?:ja|jp|jpn|japanese|en|eng|english|zh|zho|chi|chs|cht|sc|tc|gb|big5|zh-hans|zh-hant|zh-cn|zh-tw|zh-hk|ko|kor|default|forced|sdh|cc|full|signs)$/i;

const RE_CRC = /^[0-9a-f]{8}$/i;
const RE_YEAR = /^(?:19|20)\d{2}$/;
const RE_RESOLUTION = /\b(\d{3,4})[pi]\b/i;
const RE_DIMENSIONS = /\b\d{3,4}x(\d{3,4})\b/i;
const RE_4K = /\b(?:4K|UHD)\b/i;
const RE_SOURCE_BD = /\b(?:BD|BDRip|BDRemux|BDMV|Blu-?Ray)\b/i;
const RE_SOURCE_WEB = /\b(?:WEB(?:-?DL|-?Rip)?|AMZN|CR|NF|DSNP|HIDIVE|ADN|Baha|B-Global)\b/i;
const RE_SOURCE_TV = /\b(?:HDTV|TVRip|TV)\b/;
const RE_SOURCE_DVD = /\b(?:DVD|DVDRip|DVD-?Remux)\b/i;
const RE_VIDEO_CODEC = /\b(HEVC|AVC|AV1|VP9|x\.?26[45]|H[ .]?26[45])\b/i;
const RE_AUDIO_CODEC = /\b(FLAC|E-?AC-?3|AC-?3|AAC|DDP|DTS(?:-HD(?: MA)?)?|TrueHD|Opus|MP3|L?PCM)(?=\b|\d)/i;
/** Any of the above, used to find where the "tag soup" begins in un-bracketed names. */
const TAG_SOURCES = [
  RE_RESOLUTION, RE_DIMENSIONS, RE_4K, RE_SOURCE_BD, RE_SOURCE_WEB, RE_SOURCE_DVD,
  /\b(?:HDTV|TVRip)\b/, RE_VIDEO_CODEC, RE_AUDIO_CODEC, /\b(?:10|8)-?bit\b/i, /\bHi10P?\b/i,
];

const KANJI_DIGITS: Readonly<Record<string, number>> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

interface Bracket {
  readonly content: string;
  /** Offset of the opening bracket in the working string. */
  readonly index: number;
  readonly kind: 'square' | 'paren' | 'lenticular' | 'quote';
}

/** Mutable accumulator used while parsing; copied into the readonly result at the end. */
interface Draft {
  episode?: number;
  episodeRange?: readonly [number, number];
  season?: number;
  version?: number;
  releaseGroup?: string;
  resolution?: string;
  source?: 'BD' | 'WEB' | 'TV' | 'DVD';
  videoCodec?: string;
  audioCodec?: string;
  crc32?: string;
  year?: number;
}

/**
 * Parse a release-style file name into title / episode / quality metadata.
 *
 * @param fileName A bare file name or a path (`/` or `\` separated); the
 *   directory part and a known media/subtitle extension are ignored.
 * @returns Always a value; `title` falls back to the name without extension.
 */
export function parseEpisodeName(fileName: string): ParsedEpisodeName {
  try {
    return parseUnsafe(fileName);
  } catch {
    return { raw: fileName, title: stripExtension(baseName(String(fileName))).trim(), isBatch: false };
  }
}

/** Last path segment of a `/` or `\` separated path. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Remove a known extension (plus a `.ja`-style suffix for subtitles). */
function stripExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (!m || !MEDIA_EXTENSIONS.has((m[1] as string).toLowerCase())) return name;
  let out = name.slice(0, m.index);
  if (SUBTITLE_EXTENSIONS.has((m[1] as string).toLowerCase())) {
    // `Title - 01.ja.forced.ass` → strip up to two flavour suffixes.
    for (let i = 0; i < 2 && SUBTITLE_SUFFIX.test(out); i++) out = out.replace(SUBTITLE_SUFFIX, '');
  }
  return out;
}

/** Convert `一`..`九百九十九` (and plain digit strings) to a number. */
export function parseJapaneseNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  if (!/^[〇零一二三四五六七八九十百]+$/.test(text)) return undefined;
  let total = 0;
  let digit = 0;
  for (const ch of text) {
    if (ch === '百') {
      total += (digit || 1) * 100;
      digit = 0;
    } else if (ch === '十') {
      total += (digit || 1) * 10;
      digit = 0;
    } else {
      digit = digit * 10 + (KANJI_DIGITS[ch] ?? 0);
    }
  }
  return total + digit;
}

/** Extract resolution / source / codecs from a fragment into `draft` (first hit wins). */
function collectTags(text: string, draft: Draft): boolean {
  let found = false;
  if (draft.resolution === undefined) {
    const r = RE_RESOLUTION.exec(text);
    const d = RE_DIMENSIONS.exec(text);
    if (r) draft.resolution = `${r[1]}p`;
    else if (d) draft.resolution = `${d[1]}p`;
    else if (RE_4K.test(text)) draft.resolution = '2160p';
  }
  if (draft.source === undefined) {
    if (RE_SOURCE_BD.test(text)) draft.source = 'BD';
    else if (RE_SOURCE_WEB.test(text)) draft.source = 'WEB';
    else if (RE_SOURCE_DVD.test(text)) draft.source = 'DVD';
    else if (RE_SOURCE_TV.test(text)) draft.source = 'TV';
  }
  if (draft.videoCodec === undefined) {
    const v = RE_VIDEO_CODEC.exec(text);
    if (v) draft.videoCodec = normaliseVideoCodec(v[1] as string);
  }
  if (draft.audioCodec === undefined) {
    const a = RE_AUDIO_CODEC.exec(text);
    if (a) draft.audioCodec = normaliseAudioCodec(a[1] as string);
  }
  for (const re of TAG_SOURCES) if (re.test(text)) found = true;
  if (RE_SOURCE_TV.test(text)) found = true;
  return found;
}

function normaliseVideoCodec(raw: string): string {
  const s = raw.replace(/[ .]/g, '').toLowerCase();
  if (s === 'x265' || s === 'x264') return s;
  if (s === 'h265') return 'H.265';
  if (s === 'h264') return 'H.264';
  return raw.toUpperCase();
}

function normaliseAudioCodec(raw: string): string {
  const s = raw.toUpperCase().replace(/-/g, '');
  if (s === 'OPUS') return 'Opus';
  if (s === 'TRUEHD') return 'TrueHD';
  if (s === 'EAC3') return 'E-AC-3';
  if (s === 'AC3') return 'AC-3';
  return raw.toUpperCase();
}

/** Pull `[…]`, `(…)`, `【…】`, `「…」`/`『…』` groups out of `text`, replacing them with spaces. */
function extractBrackets(text: string): { rest: string; brackets: Bracket[] } {
  const brackets: Bracket[] = [];
  const re = /\[([^\]]*)\]|\(([^)]*)\)|【([^】]*)】|「([^」]*)」|『([^』]*)』/g;
  const rest = text.replace(re, (whole, sq?: string, pa?: string, le?: string, q1?: string, q2?: string, offset?: number) => {
    const index = typeof offset === 'number' ? offset : 0;
    if (sq !== undefined) brackets.push({ content: sq.trim(), index, kind: 'square' });
    else if (pa !== undefined) brackets.push({ content: pa.trim(), index, kind: 'paren' });
    else if (le !== undefined) brackets.push({ content: le.trim(), index, kind: 'lenticular' });
    else brackets.push({ content: (q1 ?? q2 ?? '').trim(), index, kind: 'quote' });
    return ' '.repeat(whole.length);
  });
  return { rest, brackets };
}

interface EpisodeHit {
  /** Offset where the episode marker starts (title is cut here). */
  readonly index: number;
  episode?: number;
  range?: readonly [number, number];
  season?: number;
  version?: number;
}

function toInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function looksLikeYear(n: number): boolean {
  return n >= 1900 && n <= 2099;
}

/**
 * Find the episode marker in an un-bracketed string, trying the most specific
 * patterns first. Returns the offset so the caller can cut the title there.
 */
function findEpisode(text: string, allowTrailing: boolean): EpisodeHit | undefined {
  // S01E02, S01E01-E12, S1 E2
  let m = /\bS(\d{1,2})[\s.]?E(\d{1,4})(?:v(\d+))?(?:\s*[-~]\s*E?(\d{1,4}))?/i.exec(text);
  if (m) {
    const season = toInt(m[1]);
    const a = toInt(m[2]) as number;
    const b = toInt(m[4]);
    const hit: EpisodeHit = { index: m.index };
    if (season !== undefined) hit.season = season;
    if (b !== undefined && b > a) hit.range = [a, b];
    else hit.episode = a;
    const v = toInt(m[3]);
    if (v !== undefined) hit.version = v;
    return hit;
  }
  // 第01話 / 第十二話 / 第3集
  m = /第\s*(\d+|[〇零一二三四五六七八九十百]+)\s*[話话集回]/.exec(text);
  if (m) {
    const n = parseJapaneseNumber(m[1] as string);
    if (n !== undefined) return { index: m.index, episode: n };
  }
  // Episode 5 / Ep.05 / EP05
  m = /\b(?:Episode|Ep)\.?\s*(\d{1,4})(?:v(\d+))?\b/i.exec(text);
  if (m) return withVersion({ index: m.index, episode: toInt(m[1]) as number }, m[2]);
  // Batch: 01-12, 01~12, 01 ～ 12. A spaced `-` needs equal zero-padded widths
  // (`01 - 12`) so `Title 2 - 10` stays "episode 10 of Title 2".
  m = /(?:^|[\s\-])(\d{1,4})(?:v\d+)?(\s*)([-~〜～])(\s*)(\d{1,4})(?:v\d+)?(?=$|\s)/.exec(text);
  if (m) {
    const a = toInt(m[1]) as number;
    const b = toInt(m[5]) as number;
    const spacedDash = m[3] === '-' && (m[2] !== '' || m[4] !== '');
    const widthOk = !spacedDash || ((m[1] as string).length >= 2 && (m[1] as string).length === (m[5] as string).length);
    if (b > a && widthOk && !(looksLikeYear(a) && looksLikeYear(b))) {
      return { index: m.index + (m[0].length - m[0].replace(/^[\s-]/, '').length), range: [a, b] };
    }
  }
  // "Title - 01", "Title - 12.5v2" (last occurrence; titles may contain " - ")
  const dash = /\s[-–]\s+(\d{1,4}(?:\.\d)?)(?:v(\d+))?(?=$|\s)/g;
  let last: RegExpExecArray | null = null;
  for (let d = dash.exec(text); d; d = dash.exec(text)) last = d;
  if (last) {
    const n = toInt(last[1]) as number;
    if (!looksLikeYear(n) || last[1]?.length !== 4) return withVersion({ index: last.index, episode: n }, last[2]);
  }
  // 01v2 anywhere
  m = /(?:^|\s)(\d{1,4})v(\d+)(?=$|\s)/.exec(text);
  if (m) return withVersion({ index: m.index, episode: toInt(m[1]) as number }, m[2]);
  // #05 / # 578
  m = /#\s*(\d{1,4})\b/.exec(text);
  if (m) return { index: m.index, episode: toInt(m[1]) as number };
  // Trailing bare number: "Title 05", "Title 05 END" (not "Season 2"; skipped when a
  // bracket such as `[01]` already names the episode).
  if (!allowTrailing) return undefined;
  m = /(?:^|\s)(\d{1,4}(?:\.\d)?)\s*(?:END|Fin|完)?\s*$/i.exec(text);
  if (m && !/\bSeason\s*$/i.test(text.slice(0, m.index + 1))) {
    const n = toInt(m[1]) as number;
    if (!(looksLikeYear(n) && m[1]?.length === 4)) return { index: m.index, episode: n };
  }
  return undefined;
}

function withVersion(hit: EpisodeHit, v: string | undefined): EpisodeHit {
  const n = toInt(v);
  if (n !== undefined) hit.version = n;
  return hit;
}

/** Interpret a bracket that holds only an episode (`[01]`, `[01v2]`, `[01-12]`, `[第01話]`). */
function episodeFromBracket(content: string): EpisodeHit | undefined {
  let m = /^(?:EP?\.?\s*)?(\d{1,4}(?:\.\d)?)(?:v(\d+))?(?:\s*END)?$/i.exec(content);
  if (m && !(RE_YEAR.test(m[1] as string))) return withVersion({ index: 0, episode: toInt(m[1]) as number }, m[2]);
  m = /^(\d{1,4})\s*[-~〜～]\s*(\d{1,4})(?:\s*(?:Fin|END))?$/i.exec(content);
  if (m) {
    const a = toInt(m[1]) as number;
    const b = toInt(m[2]) as number;
    if (b > a) return { index: 0, range: [a, b] };
  }
  m = /^第\s*(\d+|[〇零一二三四五六七八九十百]+)\s*[話话集回]$/.exec(content);
  if (m) {
    const n = parseJapaneseNumber(m[1] as string);
    if (n !== undefined) return { index: 0, episode: n };
  }
  return undefined;
}

function applyHit(draft: Draft, hit: EpisodeHit): void {
  if (hit.episode !== undefined) draft.episode = hit.episode;
  if (hit.range !== undefined) draft.episodeRange = hit.range;
  if (hit.season !== undefined) draft.season = hit.season;
  if (hit.version !== undefined) draft.version = hit.version;
}

/**
 * Map full-width digits, Latin letters, brackets and the ideographic space to
 * ASCII while leaving other characters (`！`, `～`, kana) untouched so titles
 * keep their original spelling.
 */
function narrowWidth(text: string): string {
  return text.replace(/[０-９Ａ-Ｚａ-ｚ（）［］\u3000]/g, (ch) =>
    ch === '\u3000' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
}

/** Trim separators and collapse whitespace. */
function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–_.:|~,]+|[\s\-–_.:|~,]+$/g, '')
    .trim();
}

/** Core parser; may throw on pathological input (the public wrapper catches). */
function parseUnsafe(fileName: string): ParsedEpisodeName {
  const raw = fileName;
  const draft: Draft = {};
  let work = narrowWidth(stripExtension(baseName(fileName)));

  // Scene style (`Title.S01E02.1080p.WEB-DL.x264-GRP`): dots/underscores are separators.
  const scene = !/\s/.test(work) && /[._]/.test(work);

  // Strip standalone YouTube 11-char video ID brackets at the end (`_[cEE5gee6cx4]`), unless they hold release tags.
  work = work.replace(/(?:[\s_]+)\[([A-Za-z0-9_-]{11})\]\s*$/, (whole, id: string) => {
    const probe: Draft = {};
    const spaced = id.replace(/_/g, ' ');
    if (
      collectTags(spaced, probe) ||
      /\b(?:batch|complete|dual[ -]?audio|multi[ -]?subs?|raw|eng?\s*subs?)\b/i.test(spaced) ||
      episodeFromBracket(spaced) !== undefined
    ) {
      return whole;
    }
    return ' '.repeat(whole.length);
  });

  if (scene) {
    const groupMatch = /-([A-Za-z0-9]+)$/.exec(work);
    if (groupMatch && /[._]/.test(work.slice(0, groupMatch.index))) {
      const before = work.slice(0, groupMatch.index);
      // Only treat `-GRP` as a group when it trails tag soup (avoids `Title-Sub` names).
      if (TAG_SOURCES.some((re) => re.test(before.replace(/[._]/g, ' ')))) {
        draft.releaseGroup = groupMatch[1] as string;
        work = before;
      }
    }
    work = work.replace(
      /(?:^|(?<=[\s._]))((?:19|20)\d{2})[-./](?:0[1-9]|1[0-2])[-./](?:0[1-9]|[12]\d|3[01])(?:[\s._]*OA)?(?=$|[\s._])/gi,
      (m, yr: string) => {
        draft.year ??= Number.parseInt(yr, 10);
        return ' '.repeat(m.length);
      },
    );
    // Keep `H.264` and audio channel layouts (`AAC2.0`, `DDP5.1`) intact before splitting on dots.
    work = work.replace(/(H|x)\.(26[45])/gi, '$1$2').replace(/(\d)\.([01])(?=$|[._-])/g, '$1\u0000$2');
    work = work.replace(/[._]/g, ' ').replace(/\u0000/g, '.');
  } else {
    work = work.replace(/_/g, ' ');
  }

  // Strip full calendar dates (`2026-08-23`, `2026.08.23 OA`) so they are never misread as episode ranges or titles.
  work = work.replace(
    /\b((?:19|20)\d{2})[-./](?:0[1-9]|1[0-2])[-./](?:0[1-9]|[12]\d|3[01])(?:\s*OA\b)?/gi,
    (m, yr: string) => {
      draft.year ??= Number.parseInt(yr, 10);
      return ' '.repeat(m.length);
    },
  );

  const { rest, brackets } = extractBrackets(work);
  const titleCandidates: string[] = [];
  let bracketEpisode: EpisodeHit | undefined;

  brackets.forEach((b, i) => {
    const c = b.content;
    if (b.kind === 'quote' || c === '') return; // quote brackets are handled after episode marker detection
    if (b.kind === 'lenticular' && /^(?:公式|おまけ.*|予告|特報|PV|CM)$/i.test(c)) return;
    if (RE_CRC.test(c) && /\d/.test(c) && b.kind === 'square') {
      draft.crc32 = c.toUpperCase();
      return;
    }
    if (RE_YEAR.test(c)) {
      draft.year = Number.parseInt(c, 10);
      return;
    }
    const ep = episodeFromBracket(c);
    if (ep) {
      bracketEpisode ??= ep;
      return;
    }
    if (/^v(\d+)$/i.test(c)) {
      draft.version = Number.parseInt(c.slice(1), 10);
      return;
    }
    const isTag = collectTags(c, draft) || /\b(?:batch|complete|dual[ -]?audio|multi[ -]?subs?|raw|eng?\s*subs?)\b/i.test(c);
    if (isTag) {
      const yr = /\b((?:19|20)\d{2})\b/.exec(c);
      if (yr && draft.year === undefined) draft.year = Number.parseInt(yr[1] as string, 10);
      return;
    }
    // Ignore trailing standalone YouTube 11-char ID brackets as title candidates.
    if (b.kind === 'square' && b.index > 0 && rest.slice(b.index).trim() === '' && /^[A-Za-z0-9_-]{11}$/.test(c)) {
      return;
    }
    // Free text: a leading `[...]` is the release group, the rest are title candidates.
    if (i === 0 && rest.slice(0, b.index).trim() === '' && b.kind !== 'paren' && draft.releaseGroup === undefined) {
      draft.releaseGroup = c;
    } else {
      titleCandidates.push(c);
    }
  });

  // Episode marker outside brackets, searched only before the tag soup starts.
  let tagStart = rest.length;
  for (const re of TAG_SOURCES) {
    const m = re.exec(rest);
    if (m && m.index < tagStart && m.index > 0) tagStart = m.index;
  }
  collectTags(rest, draft);
  const head = rest.slice(0, tagStart);
  const hit = findEpisode(head, bracketEpisode === undefined);
  let titleText = head;
  if (hit) {
    applyHit(draft, hit);
    titleText = head.slice(0, hit.index);
    const preEpisodeQuotes = brackets
      .filter((b) => b.kind === 'quote' && b.content !== '' && b.index < hit.index)
      .map((b) => b.content);
    if (preEpisodeQuotes.length > 0) {
      titleCandidates.unshift(...preEpisodeQuotes);
    }
  } else if (bracketEpisode) {
    applyHit(draft, bracketEpisode);
  } else if (cleanTitle(titleText) === '' && titleCandidates.length === 0 && draft.releaseGroup === undefined) {
    const firstQuote = brackets.find((b) => b.kind === 'quote' && b.content !== '');
    if (firstQuote) titleCandidates.push(firstQuote.content);
  }

  // Season markers left in the title: `S2` / `Season 2` are removed, `2nd Season` / `第2期` kept.
  titleText = titleText.replace(/(?:^|\s)S(\d{1,2})(?=\s*$)/i, (_m, s: string) => {
    draft.season ??= Number.parseInt(s, 10);
    return ' ';
  });
  titleText = titleText.replace(/\bSeason\s*(\d{1,2})\s*$/i, (_m, s: string) => {
    draft.season ??= Number.parseInt(s, 10);
    return ' ';
  });
  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i.exec(titleText) ?? /第\s*(\d+|[一二三四五六七八九十]+)\s*期/.exec(titleText);
  if (ordinal && draft.season === undefined) {
    const n = parseJapaneseNumber(ordinal[1] as string);
    if (n !== undefined) draft.season = n;
  }
  // Trailing standalone year (scene style `Title 2024 S01E01`).
  titleText = titleText.replace(/\s((?:19|20)\d{2})\s*$/, (_m, y: string) => {
    draft.year ??= Number.parseInt(y, 10);
    return ' ';
  });

  let title = cleanTitle(titleText);
  if (title === '' && titleCandidates.length > 0) title = cleanTitle(titleCandidates[0] as string);
  if (title === '' && draft.releaseGroup !== undefined && titleCandidates.length === 0 && !hit && !bracketEpisode) {
    // `[Title].mkv` — a lone bracket is more likely the title than a group.
    title = draft.releaseGroup;
    delete draft.releaseGroup;
  }
  if (title === '') title = cleanTitle(stripExtension(baseName(fileName)));

  const isBatch = draft.episodeRange !== undefined || /\b(?:batch|complete)\b/i.test(work);
  return { raw, title, isBatch, ...draft };
}
