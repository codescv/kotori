/**
 * Clean-room Japanese deinflector (MIT).
 *
 * Written from scratch from standard school grammar (五段/一段/カ変/サ変/ザ変/
 * 形容詞 conjugation tables) plus the colloquial contractions that dominate
 * anime dialogue (ちゃう/てる/とく/ねえ/なきゃ/りゃ/ん …). It intentionally does
 * not derive from any third-party (GPL or otherwise) transform table.
 *
 * Model
 * -----
 * A rule rewrites a surface suffix `from` into `to`. The form being rewritten
 * must belong to one of `inClasses` (the raw user input matches every rule);
 * the rewritten form belongs to `outClasses`. Rules are applied breadth-first,
 * so the shortest derivation of every (term, classes) pair wins, up to
 * {@link MAX_DEINFLECT_DEPTH} steps.
 *
 * Classes fall in two groups:
 *  - dictionary classes (`v1`, `v5`, `vk`, `vs`, `vz`, `adj-i`): forms that may
 *    be looked up as headwords and are returned as candidates;
 *  - intermediate classes (`te`, `ta`, `nai`, `masu`, …): inflected forms
 *    that only exist to chain further rules.
 *
 * Auxiliaries that conjugate like a verb/adjective are classified by their
 * conjugation: 〜ちゃう/〜てしまう/〜ておく conjugate as `v5`, 〜ている/〜てる and
 * passive/causative/potential forms as `v1`; 〜ない as `nai`, 〜たい as `tai`.
 */

/** Dictionary-form classes plus intermediate inflection classes. */
export type WordClass =
  // Dictionary (lookup) classes.
  | 'v1' // 一段: 食べる
  | 'v5' // 五段: 書く, 言う
  | 'vk' // カ変: 来る
  | 'vs' // サ変: する, 勉強する (and the bare noun of a Nする compound)
  | 'vz' // ザ変: 信ずる
  | 'adj-i' // 形容詞: 高い
  // Intermediate classes (never returned as lookup candidates).
  | 'masu' // 〜ます
  | 'masen' // 〜ません
  | 'te' // 〜て / 〜で
  | 'ta' // 〜た / 〜だ (past)
  | 'nai' // 〜ない (negative auxiliary, conjugates like an adjective)
  | 'ba' // 〜ば (conditional)
  | 'tai' // 〜たい (desiderative auxiliary)
  | 'iru' // reserved alias: 〜ている forms are classified as `v1`
  | 'chau' // reserved alias: 〜ちゃう forms are classified as `v5`
  | 'cond' // 〜たら
  | 'tari' // 〜たり
  | 'vol' // 〜よう / 〜おう
  | 'imp' // 命令形
  | 'neg' // classical/colloquial negative endings 〜ず / 〜ぬ / 〜ん
  | 'adv' // adverbial 〜く
  | 'noun' // 〜さ nominalisation
  | 'sou' // 〜そう (appearance)
  | 'conj' // 〜ちゃ / 〜ては / 〜ても
  | 'nominal'; // 〜てん / 〜てるん (〜ているの)

export interface DeinflectRule {
  from: string;
  to: string;
  inClasses: readonly WordClass[];
  outClasses: readonly WordClass[];
  reason: string;
}

export interface Deinflection {
  term: string;
  wordClasses: readonly WordClass[];
  /** Reasons in surface → lemma order. */
  reasons: readonly string[];
  /** Intermediate forms, surface first, term last. */
  path: readonly string[];
}

export interface PrefixDeinflection {
  surface: string;
  /** Length of `surface` in UTF-16 code units (i.e. `text.slice(0, matchedLength) === surface`). */
  matchedLength: number;
  term: string;
  wordClasses: readonly WordClass[];
  reasons: readonly string[];
  path: readonly string[];
}

/** Classes that denote a dictionary (lookup) form. */
export const DICTIONARY_WORD_CLASSES: readonly WordClass[] = ['v1', 'v5', 'vk', 'vs', 'vz', 'adj-i'];
const DICTIONARY_SET: ReadonlySet<WordClass> = new Set(DICTIONARY_WORD_CLASSES);
const VERB_CLASSES: readonly WordClass[] = ['v1', 'v5', 'vk', 'vs', 'vz'];

/** Maximum number of rule applications in one derivation. */
export const MAX_DEINFLECT_DEPTH = 8;
/** Hard cap on explored (term, classes) states per word, to bound pathological inputs. */
const MAX_STATES = 2000;

// ---------------------------------------------------------------------------
// Rule table construction
// ---------------------------------------------------------------------------

const draft: DeinflectRule[] = [];

function rule(from: string, to: string, inClasses: readonly WordClass[], outClasses: readonly WordClass[], reason: string): void {
  draft.push({ from, to, inClasses, outClasses, reason });
}

/**
 * One conjugation paradigm: every field is the full surface ending that
 * replaces `dict` (e.g. godan む: mizen `ま`, te `んで`).
 */
interface VerbRow {
  cls: WordClass;
  dict: string;
  /** 未然形 used before ない. */
  mizen?: string | undefined;
  /** 連用形 used before ます / たい. */
  renyo?: string | undefined;
  te: string;
  ta: string;
  ba?: string | undefined;
  imp?: readonly string[] | undefined;
  vol?: string | undefined;
  passive?: string | undefined;
  causative?: string | undefined;
  potential?: readonly string[] | undefined;
  /** Short causative-passive (読まされる). */
  causPassShort?: string | undefined;
}

/** [dict, a-row, i-row, e-row, o-row, te, ta] for each godan ending. */
const GODAN: readonly (readonly [string, string, string, string, string, string, string])[] = [
  ['う', 'わ', 'い', 'え', 'お', 'って', 'った'],
  ['く', 'か', 'き', 'け', 'こ', 'いて', 'いた'],
  ['ぐ', 'が', 'ぎ', 'げ', 'ご', 'いで', 'いだ'],
  ['す', 'さ', 'し', 'せ', 'そ', 'して', 'した'],
  ['つ', 'た', 'ち', 'て', 'と', 'って', 'った'],
  ['ぬ', 'な', 'に', 'ね', 'の', 'んで', 'んだ'],
  ['ぶ', 'ば', 'び', 'べ', 'ぼ', 'んで', 'んだ'],
  ['む', 'ま', 'み', 'め', 'も', 'んで', 'んだ'],
  ['る', 'ら', 'り', 'れ', 'ろ', 'って', 'った'],
];

const ROWS: VerbRow[] = [
  {
    cls: 'v1',
    dict: 'る',
    mizen: '',
    renyo: '',
    te: 'て',
    ta: 'た',
    ba: 'れば',
    imp: ['ろ'],
    vol: 'よう',
    passive: 'られる',
    causative: 'させる',
    potential: ['られる', 'れる'], // れる = ら抜き言葉
  },
];
for (const [dict, a, i, e, o, te, ta] of GODAN) {
  ROWS.push({
    cls: 'v5',
    dict,
    mizen: a,
    renyo: i,
    te,
    ta,
    ba: `${e}ば`,
    imp: [e],
    vol: `${o}う`,
    passive: `${a}れる`,
    causative: `${a}せる`,
    potential: [`${e}る`],
    causPassShort: dict === 'す' ? undefined : `${a}される`,
  });
}
// 行く is the one godan く verb with a っ te/ta form.
ROWS.push({ cls: 'v5', dict: '行く', te: '行って', ta: '行った' });
ROWS.push({ cls: 'v5', dict: 'いく', te: 'いって', ta: 'いった' });
// カ変 (kanji and kana spellings).
ROWS.push({
  cls: 'vk',
  dict: '来る',
  mizen: '来',
  renyo: '来',
  te: '来て',
  ta: '来た',
  ba: '来れば',
  imp: ['来い'],
  vol: '来よう',
  passive: '来られる',
  causative: '来させる',
  potential: ['来られる', '来れる'],
});
ROWS.push({
  cls: 'vk',
  dict: 'くる',
  mizen: 'こ',
  renyo: 'き',
  te: 'きて',
  ta: 'きた',
  ba: 'くれば',
  imp: ['こい'],
  vol: 'こよう',
  passive: 'こられる',
  causative: 'こさせる',
  potential: ['こられる', 'これる'],
});
// サ変 (also covers every Nする compound, since rules are suffix-based).
ROWS.push({
  cls: 'vs',
  dict: 'する',
  mizen: 'し',
  renyo: 'し',
  te: 'して',
  ta: 'した',
  ba: 'すれば',
  imp: ['しろ', 'せよ'],
  vol: 'しよう',
  passive: 'される',
  causative: 'させる',
});
// ザ変 (信ずる, 論ずる).
ROWS.push({
  cls: 'vz',
  dict: 'ずる',
  mizen: 'じ',
  renyo: 'じ',
  te: 'じて',
  ta: 'じた',
  ba: 'ずれば',
  imp: ['じろ', 'ぜよ'],
  vol: 'じよう',
});

/** て→ちゃう, で→じゃう (contraction of て/でしまう). */
function chauOf(te: string): string {
  return te.endsWith('で') ? `${te.slice(0, -1)}じゃう` : `${te.slice(0, -1)}ちゃう`;
}

for (const row of ROWS) {
  const { cls, dict } = row;
  const out = [cls] as const;
  rule(row.te, dict, ['te'], out, 'te');
  rule(row.ta, dict, ['ta'], out, 'past');
  rule(chauOf(row.te), dict, ['v5'], out, 'chau (te-shimau)');
  if (row.mizen !== undefined) rule(`${row.mizen}ない`, dict, ['nai'], out, 'negative');
  if (row.renyo !== undefined) {
    rule(`${row.renyo}ます`, dict, ['masu'], out, 'polite');
    rule(`${row.renyo}たい`, dict, ['tai'], out, 'desiderative (tai)');
  }
  if (row.ba !== undefined) rule(row.ba, dict, ['ba'], out, 'conditional (ba)');
  for (const imp of row.imp ?? []) rule(imp, dict, ['imp'], out, 'imperative');
  if (row.vol !== undefined) rule(row.vol, dict, ['vol'], out, 'volitional');
  const potential = row.potential ?? [];
  if (row.passive !== undefined) {
    rule(row.passive, dict, ['v1'], out, potential.includes(row.passive) ? 'passive/potential' : 'passive');
  }
  for (const pot of potential) if (pot !== row.passive) rule(pot, dict, ['v1'], out, 'potential');
  if (row.causative !== undefined) rule(row.causative, dict, ['v1'], out, 'causative');
  if (row.causPassShort !== undefined) rule(row.causPassShort, dict, ['v1'], out, 'causative-passive');
}

// サ変 specials.
rule('できる', 'する', ['v1'], ['vs'], 'potential');
rule('せず', 'する', ['neg'], ['vs'], 'negative (zu)');
rule('せぬ', 'する', ['neg'], ['vs'], 'negative (nu)');
rule('せん', 'する', ['neg'], ['vs'], 'negative (n)');
// Nする → N (JMdict tags the noun itself with `vs`).
rule('する', '', ['vs'], ['vs'], 'suru-noun');

// 五段 special honorific verbs (くださる, なさる, いらっしゃる, おっしゃる, ござる).
rule('さいます', 'さる', ['masu'], ['v5'], 'polite');
rule('ゃいます', 'ゃる', ['masu'], ['v5'], 'polite');
rule('ざいます', 'ざる', ['masu'], ['v5'], 'polite');
rule('さい', 'さる', ['imp'], ['v5'], 'imperative');
rule('ゃい', 'ゃる', ['imp'], ['v5'], 'imperative');

// Adjective-type conjugation, shared by 形容詞 and the ない / たい auxiliaries.
const ADJ_LIKE: readonly (readonly [string, WordClass])[] = [
  ['', 'adj-i'],
  ['な', 'nai'],
  ['た', 'tai'],
];
for (const [p, cls] of ADJ_LIKE) {
  rule(`${p}かった`, `${p}い`, ['ta'], [cls], 'past');
  rule(`${p}くて`, `${p}い`, ['te'], [cls], 'te');
  rule(`${p}ければ`, `${p}い`, ['ba'], [cls], 'conditional (ba)');
  rule(`${p}く`, `${p}い`, ['adv'], [cls], 'adverbial');
}
rule('くない', 'い', ['nai'], ['adj-i'], 'negative');
rule('たくない', 'たい', ['nai'], ['tai'], 'negative');
rule('さ', 'い', ['noun'], ['adj-i'], 'nominal (sa)');
rule('そう', 'い', ['sou'], ['adj-i'], 'appearance (sou)');
rule('なさそう', 'ない', ['sou'], ['nai'], 'appearance (sou)');
rule('たそう', 'たい', ['sou'], ['tai'], 'appearance (sou)');
rule('かろう', 'い', ['vol'], ['adj-i'], 'presumptive');
rule('すぎる', 'い', ['v1'], ['adj-i'], 'excess (sugiru)');
// いい / よい: the irregular adjective conjugates on the よ- stem.
rule('よかった', 'いい', ['ta'], ['adj-i'], 'past');
rule('よくて', 'いい', ['te'], ['adj-i'], 'te');
rule('よければ', 'いい', ['ba'], ['adj-i'], 'conditional (ba)');
rule('よく', 'いい', ['adv'], ['adj-i'], 'adverbial');
rule('よくない', 'いい', ['nai'], ['adj-i'], 'negative');
rule('よさそう', 'いい', ['sou'], ['adj-i'], 'appearance (sou)');

// Polite ます inflections.
rule('ました', 'ます', ['ta'], ['masu'], 'past');
rule('ませんでした', 'ません', ['ta'], ['masen'], 'past');
rule('ません', 'ます', ['masen'], ['masu'], 'negative');
rule('ましょう', 'ます', ['vol'], ['masu'], 'volitional');
rule('まして', 'ます', ['te'], ['masu'], 'te');
rule('ませ', 'ます', ['imp'], ['masu'], 'imperative');

// たら / たり are built on the past form.
rule('たら', 'た', ['cond'], ['ta'], 'conditional (tara)');
rule('だら', 'だ', ['cond'], ['ta'], 'conditional (tara)');
rule('たり', 'た', ['tari'], ['ta'], 'listing (tari)');
rule('だり', 'だ', ['tari'], ['ta'], 'listing (tari)');

// Auxiliaries attached to the te-form (and their colloquial contractions).
const TE_AUX: readonly (readonly [string, string, WordClass, string])[] = [
  ['ている', 'でいる', 'v1', 'te-iru'],
  ['てる', 'でる', 'v1', 'te-iru (contracted -teru)'],
  ['ておく', 'でおく', 'v5', 'te-oku'],
  ['とく', 'どく', 'v5', 'te-oku (contracted -toku)'],
  ['てしまう', 'でしまう', 'v5', 'te-shimau'],
  ['ちまう', 'じまう', 'v5', 'te-shimau (contracted -chimau)'],
  ['てるん', 'でるん', 'nominal', 'te-iru-no (contracted -terun)'],
  ['てん', 'でん', 'nominal', 'te-iru-no (contracted -ten)'],
  ['ちゃ', 'じゃ', 'conj', 'te-wa (contracted -cha)'],
  ['ては', 'では', 'conj', 'te-wa'],
  ['ても', 'でも', 'conj', 'te-mo'],
];
for (const [unvoiced, voiced, cls, reason] of TE_AUX) {
  rule(unvoiced, 'て', [cls], ['te'], reason);
  rule(voiced, 'で', [cls], ['te'], reason);
}
rule('なくっちゃ', 'なくて', ['conj'], ['te'], 'te-wa (contracted -kuccha)');

// Negative endings and colloquial negatives.
rule('ず', 'ない', ['neg'], ['nai'], 'negative (zu)');
rule('ぬ', 'ない', ['neg'], ['nai'], 'negative (nu)');
rule('ん', 'ない', ['neg'], ['nai'], 'negative (colloquial -n)');
rule('んない', 'らない', ['nai'], ['nai', 'adj-i'], 'negative (colloquial -nnai)');
rule('ねえ', 'ない', ['nai'], ['nai'], 'negative (colloquial -nee)');
rule('ねぇ', 'ない', ['nai'], ['nai'], 'negative (colloquial -nee)');
rule('ねー', 'ない', ['nai'], ['nai'], 'negative (colloquial -nee)');

// Colloquial conditional contractions (れば→りゃ, ければ→きゃ/けりゃ, 書けば→書きゃ …).
rule('りゃ', 'れば', ['ba'], ['ba'], 'conditional (contracted -rya)');
rule('きゃ', 'ければ', ['ba'], ['ba'], 'conditional (contracted -kya)');
rule('けりゃ', 'ければ', ['ba'], ['ba'], 'conditional (contracted -kerya)');
rule('きゃ', 'けば', ['ba'], ['ba'], 'conditional (contracted -kya)');
rule('ぎゃ', 'げば', ['ba'], ['ba'], 'conditional (contracted -gya)');
rule('びゃ', 'べば', ['ba'], ['ba'], 'conditional (contracted -bya)');
rule('みゃ', 'めば', ['ba'], ['ba'], 'conditional (contracted -mya)');
rule('ねば', 'ない', ['ba'], ['nai'], 'negative conditional (neba)');

/**
 * Merge rules that differ only in `outClasses` (e.g. 一段 ら抜き `れる→る` and
 * 五段 potential `れる→る`) so one rewrite yields one candidate with both classes.
 */
function mergeRules(rules: readonly DeinflectRule[]): DeinflectRule[] {
  const merged: DeinflectRule[] = [];
  const byKey = new Map<string, number>();
  for (const r of rules) {
    const key = `${r.from}\u0000${r.to}\u0000${r.inClasses.join(',')}\u0000${r.reason}`;
    const idx = byKey.get(key);
    const prev = idx === undefined ? undefined : merged[idx];
    if (idx === undefined || prev === undefined) {
      byKey.set(key, merged.length);
      merged.push({ ...r, outClasses: [...r.outClasses] });
      continue;
    }
    const outs = [...prev.outClasses];
    for (const c of r.outClasses) if (!outs.includes(c)) outs.push(c);
    merged[idx] = { ...prev, outClasses: outs };
  }
  return merged.map((r) => Object.freeze({ ...r, inClasses: Object.freeze([...r.inClasses]), outClasses: Object.freeze([...r.outClasses]) }));
}

export const CLEAN_DEINFLECT_RULES: readonly DeinflectRule[] = Object.freeze(mergeRules(draft));

/** Rules indexed by the last UTF-16 unit of `from` for fast suffix filtering. */
const RULES_BY_LAST_CHAR: ReadonlyMap<string, readonly DeinflectRule[]> = (() => {
  const map = new Map<string, DeinflectRule[]>();
  for (const r of CLEAN_DEINFLECT_RULES) {
    const last = r.from.slice(-1);
    const bucket = map.get(last);
    if (bucket) bucket.push(r);
    else map.set(last, [r]);
  }
  return map;
})();

// ---------------------------------------------------------------------------
// Deinflection
// ---------------------------------------------------------------------------

interface State {
  term: string;
  classes: readonly WordClass[];
  reasons: readonly string[];
  path: readonly string[];
}

function intersects(a: readonly WordClass[], b: readonly WordClass[]): boolean {
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

function stateKey(term: string, classes: readonly WordClass[]): string {
  return `${term}\u0000${[...classes].sort().join(',')}`;
}

/**
 * Deinflect `word` into candidate dictionary forms.
 *
 * The input itself is always the first result (`reasons: []`, `wordClasses: []`,
 * meaning "any class"). Further results carry only dictionary classes and are
 * ordered by derivation length (breadth-first), deduped by term + classes.
 */
export function deinflect(word: string): Deinflection[] {
  if (word.length === 0) return [];
  const results: Deinflection[] = [{ term: word, wordClasses: [], reasons: [], path: [word] }];
  const seenStates = new Set<string>([stateKey(word, [])]);
  const seenResults = new Set<string>();
  let frontier: State[] = [{ term: word, classes: [], reasons: [], path: [word] }];

  for (let depth = 0; depth < MAX_DEINFLECT_DEPTH && frontier.length > 0; depth++) {
    const next: State[] = [];
    for (const state of frontier) {
      const bucket = RULES_BY_LAST_CHAR.get(state.term.slice(-1));
      if (!bucket) continue;
      for (const r of bucket) {
        if (!state.term.endsWith(r.from)) continue;
        // The raw input (no classes yet) may be any form; derived forms must match.
        if (state.classes.length > 0 && !intersects(state.classes, r.inClasses)) continue;
        const term = state.term.slice(0, state.term.length - r.from.length) + r.to;
        if (term.length === 0) continue;
        const key = stateKey(term, r.outClasses);
        if (seenStates.has(key)) continue;
        if (seenStates.size >= MAX_STATES) return results;
        seenStates.add(key);
        const child: State = {
          term,
          classes: r.outClasses,
          reasons: [...state.reasons, r.reason],
          path: [...state.path, term],
        };
        next.push(child);
        const finals = r.outClasses.filter((c) => DICTIONARY_SET.has(c));
        if (finals.length === 0) continue;
        const resultKey = stateKey(term, finals);
        if (seenResults.has(resultKey)) continue;
        seenResults.add(resultKey);
        results.push({ term, wordClasses: finals, reasons: child.reasons, path: child.path });
      }
    }
    frontier = next;
  }
  return results;
}

/**
 * Deinflect every prefix of `text` (longest first, `maxLength` code points
 * down to 1) for hover / tap scanning. Candidates are ordered longest-first and
 * deduped by (term, matchedLength); duplicate classes are merged.
 */
export function scanPrefixDeinflections(text: string, maxLength = 16): PrefixDeinflection[] {
  const chars = Array.from(text);
  const limit = Math.min(Number.isFinite(maxLength) ? Math.floor(maxLength) : 0, chars.length);
  const results: PrefixDeinflection[] = [];
  const index = new Map<string, number>();
  for (let n = limit; n >= 1; n--) {
    const surface = chars.slice(0, n).join('');
    for (const d of deinflect(surface)) {
      const key = `${d.term}\u0000${surface.length}`;
      const idx = index.get(key);
      const prev = idx === undefined ? undefined : results[idx];
      if (idx !== undefined && prev !== undefined) {
        // An empty class list is a wildcard; otherwise union the classes.
        if (prev.wordClasses.length === 0 || d.wordClasses.length === 0) {
          results[idx] = { ...prev, wordClasses: [] };
        } else {
          const merged = [...prev.wordClasses];
          for (const c of d.wordClasses) if (!merged.includes(c)) merged.push(c);
          results[idx] = { ...prev, wordClasses: merged };
        }
        continue;
      }
      index.set(key, results.length);
      results.push({
        surface,
        matchedLength: surface.length,
        term: d.term,
        wordClasses: d.wordClasses,
        reasons: d.reasons,
        path: d.path,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Dictionary POS filtering
// ---------------------------------------------------------------------------

/** Recognised parts of speech that never accept a verb / adjective inflection. */
const NON_INFLECTING_POS: ReadonlySet<string> = new Set([
  'n', 'noun', 'pn', 'pron', 'pronoun', 'name', 'proper',
  'adv', 'adv-to', 'adverb', 'exp', 'expr', 'expression', 'phrase', 'proverb', 'idiom',
  'int', 'intj', 'interj', 'interjection', 'prt', 'particle', 'conj', 'conjunction',
  'pref', 'prefix', 'suf', 'suffix', 'ctr', 'counter', 'num', 'numeral', 'det', 'article',
  'aux', 'aux-v', 'aux-adj', 'cop', 'cop-da', 'unc', 'character', 'symbol', 'punct',
  'romanization', 'classifier', 'postp', 'postposition', 'adnominal',
]);

type PosToken = WordClass | 'verb' | 'other';

function classifyPosToken(token: string): PosToken | null {
  if (token === 'v1' || token === 'v1-s' || token === 'ichidan') return 'v1';
  if (/^v5/.test(token) || token === 'godan') return 'v5';
  if (token === 'vk' || token === 'kuru') return 'vk';
  if (/^vs(-[a-z]+)?$/.test(token) || token === 'suru') return 'vs';
  if (token === 'vz' || token === 'zuru') return 'vz';
  if (token === 'adj-i' || token === 'adj-ix' || token === 'adj' || token === 'adjective' || token === 'i-adj') return 'adj-i';
  if (token === 'v' || token === 'verb' || token === 'vt' || token === 'vi') return 'verb';
  if (NON_INFLECTING_POS.has(token)) return 'other';
  // Other JMdict POS families: classical verbs (v2*, v4*, vn, vr), na/no/taru adjectives, noun subtypes.
  if (/^v[2-4]/.test(token) || token === 'vn' || token === 'vr') return 'other';
  if (/^(adj|n|adv)-/.test(token)) return 'other';
  return null;
}

/**
 * Whether a dictionary row accepts a candidate with these classes.
 *
 * `rules` holds JMdict-style POS codes (`v1`, `v5k`, `vs-i`, `adj-i`, `n` …);
 * `defTags` may hold wty-ja-zh style tags (`v ichidan vt`, `v godan vi`,
 * `v suru`, `adj`). A generic verb tag (`v`, `vt`, `vi`) only widens to all
 * verb classes when no specific verb class is present. Rows with no
 * recognisable POS, and the raw input (empty `classes`), are wildcards.
 */
export function wordClassesMatchTermRules(classes: readonly WordClass[], rules: string, defTags?: string): boolean {
  if (classes.length === 0) return true;
  const tokens = `${rules} ${defTags ?? ''}`.toLowerCase().split(/[\s,;|/]+/u).filter((t) => t.length > 0);
  const accepted = new Set<WordClass>();
  let genericVerb = false;
  let recognised = false;
  for (const token of tokens) {
    const kind = classifyPosToken(token);
    if (kind === null) continue;
    recognised = true;
    if (kind === 'verb') genericVerb = true;
    else if (kind !== 'other') accepted.add(kind);
  }
  if (!recognised) return true;
  if (genericVerb && !VERB_CLASSES.some((c) => accepted.has(c))) for (const c of VERB_CLASSES) accepted.add(c);
  return classes.some((c) => accepted.has(c));
}
