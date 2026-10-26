/**
 * Guess a subtitle file's language from its name (`Title - 01.ja.ass`,
 * `[JP] Title.srt`, `Title 日本語.srt`, `Title.zh-Hans.ass`, …).
 */
import type { LanguageTag } from '../types';

/** Dot-suffix / bracket codes → normalised tag. Keys are lower-case. */
const CODE_MAP: Readonly<Record<string, LanguageTag>> = {
  ja: 'ja', jp: 'ja', jpn: 'ja', jap: 'ja', japanese: 'ja', 'ja-jp': 'ja',
  en: 'en', eng: 'en', english: 'en', 'en-us': 'en', 'en-gb': 'en',
  'zh-hans': 'zh-CN', 'zh-cn': 'zh-CN', 'zh-sg': 'zh-CN', 'zho-hans': 'zh-CN', 'chi-hans': 'zh-CN',
  chs: 'zh-CN', sc: 'zh-CN', gb: 'zh-CN', 'zh-hans-cn': 'zh-CN',
  'zh-hant': 'zh-TW', 'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW', 'zho-hant': 'zh-TW', 'chi-hant': 'zh-TW',
  cht: 'zh-TW', tc: 'zh-TW', big5: 'zh-TW', 'zh-hant-tw': 'zh-TW',
  zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh',
  ko: 'ko', kor: 'ko', korean: 'ko',
  es: 'es', spa: 'es', spanish: 'es', 'es-419': 'es',
  fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr',
  de: 'de', ger: 'de', deu: 'de', german: 'de',
  pt: 'pt', por: 'pt', 'pt-br': 'pt-BR',
  ru: 'ru', rus: 'ru', russian: 'ru',
  it: 'it', ita: 'it', italian: 'it',
  ar: 'ar', ara: 'ar', arabic: 'ar',
};

/** Codes that are ordinary words inside brackets (`[It]`, `[De]`) and are only trusted as dot suffixes. */
const BRACKET_ONLY_SKIP = new Set(['it', 'de', 'ar']);

/** Flavour suffixes skipped when walking dot segments right-to-left (`.ja.forced.ass`). */
const MODIFIERS = new Set(['forced', 'sdh', 'cc', 'hi', 'default', 'full', 'signs', 'songs', 'dialogue', 'ass', 'srt']);

/** Script words (checked in this order; Japanese first since Kotori is a Japanese tool). */
const WORD_RULES: readonly (readonly [RegExp, LanguageTag])[] = [
  [/日本語|日本语|日語|日语|日文|和文/, 'ja'],
  [/简体|簡体|簡體|简中|简日|簡日|中简|简繁/, 'zh-CN'],
  [/繁体|繁體|繁中|繁日|中繁/, 'zh-TW'],
  [/中文|中字/, 'zh'],
  [/英語|英语|英文/, 'en'],
];

const SUBTITLE_EXT = /\.(?:ass|ssa|srt|vtt|sub|sup|idx|txt)$/i;

/**
 * Detect the language of a subtitle file from its file name.
 *
 * Checks, in order: trailing dot segments before the extension
 * (`.ja.`, `.jpn.`, `.zh-Hans.` → `zh-CN`, `.zh-Hant.` → `zh-TW`, …),
 * bracketed codes (`[JP]`, `(ENG)`, `[CHS]`), then CJK words
 * (`日本語`, `简体`, `繁體`).
 *
 * @returns A lower-case BCP-47-ish tag (`ja`, `en`, `zh-CN`, `zh-TW`, `zh`, …)
 *   or `undefined` when nothing recognisable is present.
 */
export function detectSubtitleLanguageFromName(fileName: string): LanguageTag | undefined {
  if (typeof fileName !== 'string' || fileName === '') return undefined;
  const cut = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const base = (cut >= 0 ? fileName.slice(cut + 1) : fileName).replace(SUBTITLE_EXT, '');

  // 1. Dot suffixes, right to left, skipping modifiers. Only the last few segments count
  //    so a title word (`Title.Japanese.Lessons.S01E01`) is not mistaken for a tag.
  const segments = base.split('.');
  for (let i = segments.length - 1, seen = 0; i >= 1 && seen < 3; i--, seen++) {
    const seg = (segments[i] as string).toLowerCase().replace(/\[[^\]]*\]$/, '').trim();
    if (MODIFIERS.has(seg)) continue;
    const tag = CODE_MAP[seg];
    if (tag !== undefined) return tag;
    if (seg.length > 12) break;
  }

  // 2. Bracketed / delimited codes: `[JP]`, `(ENG)`, `[CHS&JPN]`, `_jpn_`.
  const bracket = /[[(【]([^\])】]{1,24})[\])】]/g;
  for (let m = bracket.exec(base); m; m = bracket.exec(base)) {
    const content = (m[1] as string).toLowerCase().trim();
    const whole = CODE_MAP[content];
    if (whole !== undefined && !BRACKET_ONLY_SKIP.has(content)) return whole;
    for (const part of content.split(/[\s&+,_/|-]+/)) {
      const tag = CODE_MAP[part];
      if (tag !== undefined && part.length >= 2 && !BRACKET_ONLY_SKIP.has(part)) return tag;
    }
  }
  const delimited = /(?:^|[\s_-])(jpn|japanese|chs|cht|eng)(?=$|[\s_-])/i.exec(base);
  if (delimited) return CODE_MAP[(delimited[1] as string).toLowerCase()];

  // 3. CJK words anywhere in the name.
  for (const [re, tag] of WORD_RULES) if (re.test(base)) return tag;
  return undefined;
}
