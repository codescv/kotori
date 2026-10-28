/**
 * Mock dictionary fixtures for `MockPlatformHost.dict`: three ready
 * dictionaries (Wiktionary JA-ZH glosses, Kanjium pitch accents, JPDB v2.2
 * frequencies) with hand-written `CompactTermRecord` / `DictMetaRecord`
 * rows covering the mock anime & manga vocabulary, so the breakdown panel
 * shows every enrichment state out of the box:
 *
 * - matched:   `賭ける [2] #3,851`, `食べる [2] #310`, `バンド [1] #1,420` …
 * - uncertain: kana lemma `かける` → 賭ける / 掛ける / 駆ける / 欠ける
 * - reading fallback: `分かる` → kana headword `わかる` (Orthography Guard)
 * - redirect:  `一人` → `ひとり`
 *
 * Gloss texts are short original paraphrases written for Kotori's fixtures.
 */
import {
  normalizeTermReading,
  termLookupKeys,
  type CompactSense,
  type CompactTermRecord,
  type DictionaryInfo,
  type DictMetaRecord,
  type FreqMetaData,
  type PitchMetaData,
} from '@kotori/core';

export const MOCK_WTY_ID = 'wty-ja-zh';
export const MOCK_PITCH_ID = 'kanjium-pitch';
export const MOCK_FREQ_ID = 'jpdb-freq';

const IMPORTED_AT = Date.UTC(2026, 9, 22);

export const MOCK_DICTIONARIES: readonly DictionaryInfo[] = [
  {
    id: MOCK_WTY_ID,
    title: 'Wiktionary 日中词典 (wty-ja-zh)',
    revision: '2026.10.22',
    kind: 'term',
    status: 'ready',
    priority: 0,
    enabled: true,
    termCount: 187_449,
    metaCount: 0,
    attribution: 'Wiktionary / Kaikki.org / yomidevs wty contributors',
    sourceUrl: 'https://huggingface.co/datasets/daxida/wty-release',
    importedAt: IMPORTED_AT,
  },
  {
    id: MOCK_PITCH_ID,
    title: 'Kanjium',
    revision: 'pitch1',
    kind: 'pitch',
    status: 'ready',
    priority: 1,
    enabled: true,
    termCount: 0,
    metaCount: 124_137,
    attribution: 'Uros Ozvatic (Kanjium), EDRDG, packaged by toasted-nutbread',
    sourceUrl: 'https://github.com/toasted-nutbread/yomichan-pitch-accent-dictionary',
    importedAt: IMPORTED_AT,
  },
  {
    id: MOCK_FREQ_ID,
    title: 'JPDB v2.2',
    revision: 'v2.2',
    kind: 'freq',
    status: 'ready',
    priority: 2,
    enabled: true,
    termCount: 0,
    metaCount: 338_814,
    attribution: 'Data from jpdb.io, packaged by Kuuuube & Gecko',
    importedAt: IMPORTED_AT,
  },
];

type SenseSpec = string | readonly [gloss: string, ja: string, zh: string];

interface TermSpec {
  readonly expression: string;
  readonly reading?: string;
  readonly defTags: string;
  readonly rules?: string;
  readonly score?: number;
  readonly senses?: readonly SenseSpec[];
  readonly redirectTo?: string;
}

const TERM_SPECS: readonly TermSpec[] = [
  {
    expression: '賭ける',
    reading: 'かける',
    defTags: 'v ichidan vt',
    rules: 'v1',
    senses: [['赌博，打赌，押注', '命を賭けて戦う', '赌上性命战斗'], '押上（性命、前途等）作赌注'],
  },
  {
    expression: '掛ける',
    reading: 'かける',
    defTags: 'v ichidan vt',
    rules: 'v1',
    score: 10,
    senses: [['挂，悬挂', '壁に絵を掛ける', '把画挂在墙上'], '戴上（眼镜）；盖上', '打（电话）', '花费（时间、金钱）', '乘（乘法）', '坐（在椅子等上）'],
  },
  { expression: '駆ける', reading: 'かける', defTags: 'v ichidan vi', rules: 'v1', senses: [['跑，快跑；奔驰', '空を駆ける', '在空中奔驰'], '策马飞奔'] },
  { expression: '欠ける', reading: 'かける', defTags: 'v ichidan vi', rules: 'v1', senses: [['缺，缺损', '茶碗が欠ける', '碗缺了个口'], '不足，缺少', '（月）亏'] },
  { expression: 'バンド', defTags: 'n', senses: [['乐队，乐团', 'バンドを組む', '组乐队'], '带子，皮带', '（无线电）频带'] },
  { expression: 'ライブハウス', defTags: 'n', senses: [['Livehouse，小型现场音乐演出场馆', '下北沢のライブハウスで演奏する', '在下北泽的 Livehouse 演出']] },
  { expression: '女子', reading: 'じょし', defTags: 'n', senses: [['女孩子，女生', '女子高生', '女高中生'], '女子，妇女'] },
  { expression: '感じる', reading: 'かんじる', defTags: 'v ichidan vt', rules: 'v1', senses: [['感觉，感到', '寒さを感じる', '感到寒冷'], '感受，感触；感动'] },
  { expression: '食べる', reading: 'たべる', defTags: 'v ichidan vt', rules: 'v1', senses: [['吃，食用', 'ご飯を食べる', '吃饭'], '生活，谋生（食べていく）'] },
  { expression: '言う', reading: 'いう', defTags: 'v godan vt', rules: 'v5', senses: [['说，讲', '本当のことを言う', '说实话'], '叫做，称为', '（声音）响，作响'] },
  { expression: 'ひとり', defTags: 'n', senses: [['一个人', 'ひとりで行く', '一个人去'], '独自，单独', '单身，独身'] },
  { expression: '一人', reading: 'ひとり', defTags: 'non-lemma', redirectTo: 'ひとり' },
  { expression: 'わかる', defTags: 'v godan vi', rules: 'v5', senses: [['明白，懂', '意味がわかる', '明白意思'], '知道，了解', '判明，弄清楚'] },
  { expression: '命', reading: 'いのち', defTags: 'n', senses: [['生命，性命', '命を大切にする', '珍惜生命'], '寿命', '最重要的东西，命根子'] },
  { expression: '守る', reading: 'まもる', defTags: 'v godan vt', rules: 'v5', senses: [['守护，保护', '家族を守る', '守护家人'], '遵守（约定、规则）'] },
  { expression: '待つ', reading: 'まつ', defTags: 'v godan vt', rules: 'v5', senses: [['等，等待', '駅で友達を待つ', '在车站等朋友'], '期待，指望'] },
  { expression: '行く', reading: 'いく', defTags: 'v godan vi', rules: 'v5', senses: [['去，往', '学校に行く', '去学校'], '进行，进展（順調に行く）'] },
  { expression: '諦める', reading: 'あきらめる', defTags: 'v ichidan vt', rules: 'v1', senses: [['放弃，死心', '夢を諦める', '放弃梦想']] },
];

function toSense(s: SenseSpec): CompactSense {
  return typeof s === 'string' ? { gloss: s } : { gloss: s[0], examples: [[s[1], s[2]]] };
}

function buildTerms(): CompactTermRecord[] {
  return TERM_SPECS.map((t, seq) => {
    const reading = normalizeTermReading(t.expression, t.reading ?? '');
    return {
      dictId: MOCK_WTY_ID,
      seq,
      expression: t.expression,
      reading,
      defTags: t.defTags,
      rules: t.rules ?? '',
      score: t.score ?? 0,
      sequenceId: 0,
      ...(t.redirectTo !== undefined ? { redirectTo: t.redirectTo } : {}),
      senses: (t.senses ?? []).map(toSense),
      keys: termLookupKeys(t.expression, reading),
    };
  });
}

/** `[expression, reading, position]` Kanjium rows. */
const PITCH_ROWS: readonly (readonly [string, string, number])[] = [
  ['賭ける', 'かける', 2],
  ['掛ける', 'かける', 2],
  ['駆ける', 'かける', 2],
  ['欠ける', 'かける', 0],
  ['バンド', 'ばんど', 1],
  ['ライブハウス', 'らいぶはうす', 4],
  ['女子', 'じょし', 1],
  ['感じる', 'かんじる', 0],
  ['食べる', 'たべる', 2],
  ['言う', 'いう', 0],
  ['ひとり', 'ひとり', 2],
  ['一人', 'ひとり', 2],
  ['わかる', 'わかる', 2],
  ['分かる', 'わかる', 2],
  ['命', 'いのち', 1],
  ['守る', 'まもる', 2],
  ['待つ', 'まつ', 1],
  ['行く', 'いく', 0],
  ['諦める', 'あきらめる', 4],
];

/** `[expression, reading | undefined, value, displayValue]` JPDB rows (R1: `㋕` rows only on exact pairs / bare kana). */
const FREQ_ROWS: readonly (readonly [string, string | undefined, number, string])[] = [
  ['賭ける', 'かける', 3851, '3851'],
  ['掛ける', 'かける', 2055, '2055'],
  ['掛ける', 'かける', 202, '202㋕'],
  ['かける', undefined, 202, '202㋕'],
  ['バンド', 'ばんど', 1420, '1420'],
  ['ライブハウス', 'らいぶはうす', 4200, '4200'],
  ['女子', 'じょし', 890, '890'],
  ['感じる', 'かんじる', 640, '640'],
  ['食べる', 'たべる', 310, '310'],
  ['言う', 'いう', 85, '85'],
  ['ひとり', 'ひとり', 520, '520'],
  ['分かる', 'わかる', 190, '190'],
  ['わかる', undefined, 190, '190㋕'],
  ['命', 'いのち', 1210, '1210'],
  ['守る', 'まもる', 980, '980'],
  ['待つ', 'まつ', 260, '260'],
  ['行く', 'いく', 60, '60'],
  ['諦める', 'あきらめる', 2900, '2900'],
];

function buildMeta(): DictMetaRecord[] {
  const pitch = new Map<string, PitchMetaData[]>();
  for (const [expr, reading, position] of PITCH_ROWS) {
    const list = pitch.get(expr) ?? [];
    list.push({ reading, pitches: [{ position }] });
    pitch.set(expr, list);
  }
  const freq = new Map<string, FreqMetaData[]>();
  for (const [expr, reading, value, displayValue] of FREQ_ROWS) {
    const list = freq.get(expr) ?? [];
    const kanaOnly = displayValue.includes('㋕');
    list.push({ ...(reading !== undefined ? { reading } : {}), value, displayValue, ...(kanaOnly ? { kanaOnly: true } : {}) });
    freq.set(expr, list);
  }
  return [
    ...[...pitch].map(([expression, entries]): DictMetaRecord => ({ dictId: MOCK_PITCH_ID, expression, mode: 'pitch', entries })),
    ...[...freq].map(([expression, entries]): DictMetaRecord => ({ dictId: MOCK_FREQ_ID, expression, mode: 'freq', entries })),
  ];
}

export interface MockDictionaryData {
  readonly dictionaries: DictionaryInfo[];
  readonly terms: CompactTermRecord[];
  readonly meta: DictMetaRecord[];
}

/** Fresh mutable copy of the seeded dictionary data. */
export function createMockDictionaryData(): MockDictionaryData {
  return { dictionaries: MOCK_DICTIONARIES.map((d) => ({ ...d })), terms: buildTerms(), meta: buildMeta() };
}
