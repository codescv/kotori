/**
 * Deterministic furigana for a dictionary headword (`lemma` + hiragana
 * `lemmaReading`), replacing the model-generated `lemmaRuby` (spec §4.4).
 *
 * Strategy:
 *   1. Pure kana / no reading → plain segments without ruby.
 *   2. Whole-word jukujikun / ateji (`JUKUJIKUN_READINGS`) → one group ruby.
 *   3. Okurigana / inner-kana alignment: the lemma is split into kanji runs
 *      and kana runs; kana runs are matched literally against the reading and
 *      each kanji run receives the reading between them
 *      (`取り戻す`/`とりもどす` → 取(と)り戻(もど)す, `引っ越す` → 引(ひ)っ越(こ)す).
 *      Multi-kanji runs keep one group reading (勉強(べんきょう)), so
 *      jukujikun inside a run is never split per kanji.
 *   4. Irreconcilable → strip matching kana prefix / suffix and give the rest
 *      one group reading.
 *
 * `segments.map(s => s.base).join('') === lemma` always holds; `charSpan` is
 * relative to `lemma`.
 */
import type { CharSpan, RubySegment } from '../types';
import { isKana, isKanji } from '../util/text';
import { hasKanji, katakanaToHiragana } from './zh-script';

/**
 * Whole-word irregular readings (jukujikun / ateji / irregular compounds)
 * that must be annotated as a single group. Keys are kanji-only lemmas;
 * values hiragana. Used when the reading is missing or confirms the entry;
 * lemmas with okurigana are handled by run alignment instead.
 */
export const JUKUJIKUN_READINGS: Readonly<Record<string, string>> = {
  明日: 'あした',
  今日: 'きょう',
  昨日: 'きのう',
  一昨日: 'おととい',
  明後日: 'あさって',
  今朝: 'けさ',
  今年: 'ことし',
  去年: 'きょねん',
  一昨年: 'おととし',
  今夜: 'こんや',
  大人: 'おとな',
  一人: 'ひとり',
  二人: 'ふたり',
  一日: 'ついたち',
  二日: 'ふつか',
  二十日: 'はつか',
  二十歳: 'はたち',
  上手: 'じょうず',
  下手: 'へた',
  時計: 'とけい',
  眼鏡: 'めがね',
  果物: 'くだもの',
  部屋: 'へや',
  景色: 'けしき',
  土産: 'みやげ',
  浴衣: 'ゆかた',
  素人: 'しろうと',
  玄人: 'くろうと',
  仲人: 'なこうど',
  若人: 'わこうど',
  田舎: 'いなか',
  息子: 'むすこ',
  真面目: 'まじめ',
  為替: 'かわせ',
  七夕: 'たなばた',
  梅雨: 'つゆ',
  五月雨: 'さみだれ',
  時雨: 'しぐれ',
  吹雪: 'ふぶき',
  雪崩: 'なだれ',
  紅葉: 'もみじ',
  海老: 'えび',
  河豚: 'ふぐ',
  煙草: 'たばこ',
  相撲: 'すもう',
  竹刀: 'しない',
  草履: 'ぞうり',
  足袋: 'たび',
  木綿: 'もめん',
  老舗: 'しにせ',
  八百屋: 'やおや',
  八百長: 'やおちょう',
  心地: 'ここち',
  居士: 'こじ',
  為体: 'ていたらく',
  所謂: 'いわゆる',
  流石: 'さすが',
  一寸: 'ちょっと',
  何卒: 'なにとぞ',
  寿司: 'すし',
  山車: 'だし',
  蚊帳: 'かや',
  太刀: 'たち',
  欠伸: 'あくび',
  息吹: 'いぶき',
  乳母: 'うば',
  叔父: 'おじ',
  伯父: 'おじ',
  叔母: 'おば',
  伯母: 'おば',
  清水: 'しみず',
  日和: 'ひより',
  白髪: 'しらが',
  三味線: 'しゃみせん',
  芝生: 'しばふ',
  数珠: 'じゅず',
  砂利: 'じゃり',
  数寄屋: 'すきや',
  師走: 'しわす',
  稚児: 'ちご',
  投網: 'とあみ',
  名残: 'なごり',
  雪洞: 'ぼんぼり',
  迷子: 'まいご',
  土筆: 'つくし',
  百合: 'ゆり',
  行方: 'ゆくえ',
  寄席: 'よせ',
  若布: 'わかめ',
  早乙女: 'さおとめ',
  桟敷: 'さじき',
  博士: 'はかせ',
  波止場: 'はとば',
  一言: 'ひとこと',
};

function seg(base: string, start: number, ruby?: string): RubySegment {
  const charSpan: CharSpan = [start, start + base.length];
  return ruby === undefined || ruby === '' ? { base, charSpan } : { base, ruby, charSpan };
}

interface Run {
  readonly text: string;
  readonly start: number;
  readonly kanji: boolean;
}

/** Split into maximal kanji / non-kanji runs. */
function runs(text: string): Run[] {
  const out: Run[] = [];
  let i = 0;
  for (const ch of text) {
    const k = isKanji(ch);
    const last = out[out.length - 1];
    if (last && last.kanji === k) out[out.length - 1] = { text: last.text + ch, start: last.start, kanji: k };
    else out.push({ text: ch, start: i, kanji: k });
    i += ch.length;
  }
  return out;
}

function plain(lemma: string): RubySegment[] {
  return runs(lemma).map((r) => seg(r.text, r.start));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Non-kanji chars of a run must be kana (or symbols that also appear in the reading) to match literally. */
function foldKana(s: string): string {
  return katakanaToHiragana(s);
}

/**
 * Align kanji runs to the reading by matching kana runs literally. Returns
 * the reading of each kanji run, or `undefined` when no alignment exists.
 */
function alignRuns(parts: readonly Run[], reading: string): string[] | undefined {
  const pattern = parts.map((p) => (p.kanji ? '(.+?)' : escapeRegExp(foldKana(p.text)))).join('');
  const m = new RegExp(`^${pattern}$`, 'u').exec(reading);
  if (!m) return undefined;
  return m.slice(1).map((g) => g ?? '');
}

/** Fallback: strip matching kana prefix / suffix, group the middle. */
function prefixSuffixFallback(lemma: string, reading: string): RubySegment[] {
  const chars = [...lemma];
  const rChars = [...reading];
  let p = 0;
  while (p < chars.length && p < rChars.length && !isKanji(chars[p]!) && isKana(chars[p]!) && foldKana(chars[p]!) === rChars[p]) p++;
  let s = 0;
  while (
    s < chars.length - p &&
    s < rChars.length - p &&
    !isKanji(chars[chars.length - 1 - s]!) &&
    isKana(chars[chars.length - 1 - s]!) &&
    foldKana(chars[chars.length - 1 - s]!) === rChars[rChars.length - 1 - s]
  )
    s++;
  const prefix = chars.slice(0, p).join('');
  const middle = chars.slice(p, chars.length - s).join('');
  const suffix = chars.slice(chars.length - s).join('');
  const middleReading = rChars.slice(p, rChars.length - s).join('');
  if (middle === '' || middleReading === '') return [seg(lemma, 0, reading)];
  const out: RubySegment[] = [];
  if (prefix) out.push(seg(prefix, 0));
  out.push(seg(middle, prefix.length, middleReading));
  if (suffix) out.push(seg(suffix, prefix.length + middle.length));
  return out;
}

/**
 * Compute furigana segments for a dictionary headword. `lemmaReading` may be
 * katakana; it is folded to hiragana. See module doc for the algorithm.
 */
export function computeLemmaRuby(lemma: string, lemmaReading: string): RubySegment[] {
  if (lemma === '') return [];
  const table = JUKUJIKUN_READINGS[lemma];
  let reading = foldKana(lemmaReading.trim());
  if (!hasKanji(lemma)) return plain(lemma);
  if (reading === '') {
    if (table !== undefined) return [seg(lemma, 0, foldKana(table))];
    return plain(lemma);
  }
  if (table !== undefined && foldKana(table) === reading) return [seg(lemma, 0, reading)];
  if (/\s/.test(reading)) reading = reading.replace(/\s+/g, '');

  const parts = runs(lemma);
  const kanjiReadings = alignRuns(parts, reading);
  if (kanjiReadings) {
    const out: RubySegment[] = [];
    let k = 0;
    for (const p of parts) {
      if (p.kanji) out.push(seg(p.text, p.start, kanjiReadings[k++]));
      else out.push(seg(p.text, p.start));
    }
    return out;
  }
  return prefixSuffixFallback(lemma, reading);
}
