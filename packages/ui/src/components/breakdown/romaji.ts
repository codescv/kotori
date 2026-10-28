/**
 * Minimal kana → Hepburn romaji (for `AnimeSettings.showRomaji` under chunk
 * readings). Local and synchronous — no model tokens. Non-kana characters are
 * passed through unchanged.
 */

const MONO: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
  '、': ', ', '。': '. ', '！': '!', '？': '?', '〜': '~', '…': '…', '　': ' ',
};

const YOON: Record<string, string> = { ゃ: 'a', ゅ: 'u', ょ: 'o' };
const SMALL_VOWEL: Record<string, string> = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
/** Bases that fuse with a following small vowel (loanword sounds). */
const COMBINING: Record<string, string> = { fu: 'f', te: 't', de: 'd', vu: 'v', u: 'w', shi: 'sh', chi: 'ch', ji: 'j', tsu: 'ts', to: 't', do: 'd' };

/** Katakana → hiragana (ァ..ヶ shift by 0x60). */
function toHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Romaji of `text` (hiragana / katakana); returns `''` when there is no kana at all. */
export function kanaToRomaji(text: string): string {
  if (!/[\u3040-\u30ff]/.test(text)) return '';
  const s = toHiragana(text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];
    if (c === 'っ') {
      const following = next ? romajiAt(s, i + 1).romaji : '';
      out += following && /^[a-z]/.test(following) && !/^[aeiou]/.test(following) ? following[0] : '';
      continue;
    }
    if (c === 'ー') {
      const m = /[aeiou](?=[^aeiou]*$)/.exec(out);
      out += m ? m[0] : '-';
      continue;
    }
    if (c === 'ん') {
      out += next && /^[aeiouy]/.test(romajiAt(s, i + 1).romaji) ? "n'" : 'n';
      continue;
    }
    const { romaji, length } = romajiAt(s, i);
    out += romaji;
    i += length - 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function romajiAt(s: string, i: number): { romaji: string; length: number } {
  const c = s[i]!;
  const next = s[i + 1];
  const base = MONO[c];
  if (base === undefined) return { romaji: c, length: 1 };
  if (next && YOON[next] && base.endsWith('i') && base.length > 1) {
    const stem = base === 'shi' || base === 'chi' || base === 'ji' ? base.slice(0, -1) : `${base.slice(0, -1)}y`;
    return { romaji: stem + YOON[next], length: 2 };
  }
  if (next && SMALL_VOWEL[next]) {
    // ふぁ fa, てぃ ti, ゔぉ vo, しぇ she, うぃ wi …; otherwise a small vowel lengthens (ねぇ nee).
    const stem = COMBINING[base];
    return { romaji: stem !== undefined ? stem + SMALL_VOWEL[next] : base + SMALL_VOWEL[next], length: 2 };
  }
  return { romaji: base, length: 1 };
}
