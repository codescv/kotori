/**
 * Mock explanation fixtures: a compact DSL that builds fully-aligned
 * `SentenceExplanation`s (chunks / vocab / grammar / ruby with exact UTF-16
 * spans) plus a heuristic generator for sentences without a canned entry.
 */
import type {
  CharSpan,
  GrammarPoint,
  PartOfSpeech,
  RubySegment,
  SemanticChunk,
  SentenceExplanation,
  SpokenEvolution,
  TargetLanguage,
  VocabEntry,
} from '@kotori/core';

type RubySpec = readonly (readonly [base: string, ruby?: string])[];

interface VocabSpec {
  readonly surface: string;
  readonly lemma: string;
  readonly lemmaReading: string;
  readonly lemmaRuby?: RubySpec;
  readonly pos: PartOfSpeech;
  readonly meaning: string;
  readonly conjugation?: string;
  readonly jlpt?: VocabEntry['jlpt'];
  readonly pitch?: number;
  readonly notes?: string;
}

interface ChunkSpec {
  readonly surface: string;
  readonly reading: string;
  readonly textbookForm?: string;
  readonly evolution?: SpokenEvolution;
  readonly role: string;
  readonly meaning: string;
  readonly nuance?: string;
  readonly vocab?: readonly VocabSpec[];
}

export interface ExplanationSpec {
  readonly sentence: string;
  readonly translation: string;
  readonly literal?: string;
  readonly register?: SentenceExplanation['register'];
  readonly tone?: string;
  /** Furigana for the whole sentence; uncovered text is filled automatically. */
  readonly ruby: RubySpec;
  readonly chunks: readonly ChunkSpec[];
  readonly grammar?: readonly { readonly pattern: string; readonly chunks: readonly string[]; readonly explanation: string; readonly jlpt?: GrammarPoint['jlpt'] }[];
}

/** Tile `text` with ruby segments: listed bases are located left-to-right. */
export function buildRubySegments(text: string, spec: RubySpec, offset = 0): RubySegment[] {
  const out: RubySegment[] = [];
  let cursor = 0;
  for (const [base, ruby] of spec) {
    const at = text.indexOf(base, cursor);
    if (at < 0) continue;
    if (at > cursor) out.push({ base: text.slice(cursor, at), charSpan: [cursor + offset, at + offset] });
    out.push(ruby ? { base, ruby, charSpan: [at + offset, at + base.length + offset] } : { base, charSpan: [at + offset, at + base.length + offset] });
    cursor = at + base.length;
  }
  if (cursor < text.length) out.push({ base: text.slice(cursor), charSpan: [cursor + offset, text.length + offset] });
  return out;
}

const slicesWithin = (segments: readonly RubySegment[], span: CharSpan): RubySegment[] =>
  segments
    .filter((s) => s.charSpan[0] < span[1] && s.charSpan[1] > span[0])
    .map((s) => {
      const start = Math.max(s.charSpan[0], span[0]);
      const end = Math.min(s.charSpan[1], span[1]);
      const whole = start === s.charSpan[0] && end === s.charSpan[1];
      const base = s.base.slice(start - s.charSpan[0], end - s.charSpan[0]);
      return whole && s.ruby ? { base, ruby: s.ruby, charSpan: [start, end] as const } : { base, charSpan: [start, end] as const };
    });

/** Build a complete `SentenceExplanation` from a spec (deterministic id). */
export function defineExplanation(spec: ExplanationSpec, targetLanguage: TargetLanguage = 'zh-CN'): SentenceExplanation {
  const { sentence } = spec;
  const ruby = buildRubySegments(sentence, spec.ruby);
  const chunks: SemanticChunk[] = [];
  const vocab: VocabEntry[] = [];
  let cursor = 0;
  spec.chunks.forEach((c, ci) => {
    const at = sentence.indexOf(c.surface, cursor);
    const span: CharSpan = at >= 0 ? [at, at + c.surface.length] : [cursor, cursor];
    if (at >= 0) cursor = span[1];
    const vocabIds: string[] = [];
    let vcursor = span[0];
    for (const v of c.vocab ?? []) {
      const vat = sentence.indexOf(v.surface, vcursor);
      const inside = vat >= 0 && vat + v.surface.length <= span[1];
      const vspan: CharSpan = inside ? [vat, vat + v.surface.length] : [vcursor, vcursor];
      if (inside) vcursor = vspan[1];
      const id = `v${vocab.length}`;
      vocabIds.push(id);
      vocab.push({
        id,
        charSpan: vspan,
        alignment: inside ? 'exact' : 'unaligned',
        surface: v.surface,
        lemma: v.lemma,
        lemmaReading: v.lemmaReading,
        lemmaRuby: buildRubySegments(v.lemma, v.lemmaRuby ?? [[v.lemma]]),
        partOfSpeech: v.pos,
        meaning: v.meaning,
        ...(v.conjugation ? { conjugation: v.conjugation } : {}),
        ...(v.jlpt ? { jlpt: v.jlpt } : {}),
        ...(v.pitch !== undefined ? { pitchAccent: v.pitch } : {}),
        ...(v.notes ? { notes: v.notes } : {}),
      });
    }
    chunks.push({
      id: `c${ci}`,
      charSpan: span,
      alignment: at >= 0 ? 'exact' : 'unaligned',
      surface: c.surface,
      reading: c.reading,
      ruby: slicesWithin(ruby, span),
      textbookForm: c.textbookForm ?? c.surface,
      ...(c.evolution ? { spokenEvolution: c.evolution } : {}),
      role: c.role,
      meaning: c.meaning,
      ...(c.nuance ? { nuance: c.nuance } : {}),
      vocabIds,
    });
  });
  const grammar: GrammarPoint[] = (spec.grammar ?? []).map((g, gi) => ({
    id: `g${gi}`,
    pattern: g.pattern,
    chunkIds: g.chunks.map((surface) => chunks.find((c) => c.surface === surface)?.id).filter((x): x is string => x !== undefined),
    explanation: g.explanation,
    ...(g.jlpt ? { jlpt: g.jlpt } : {}),
  }));
  return {
    id: `ex_mock_${hashString(`${sentence}|${targetLanguage}`)}`,
    sentence,
    ruby,
    translation: spec.translation,
    ...(spec.literal ? { literalTranslation: spec.literal } : {}),
    chunks,
    vocab,
    grammar,
    ...(spec.register ? { register: spec.register } : {}),
    ...(spec.tone ? { tone: spec.tone } : {}),
    targetLanguage,
    model: 'gemini-2.5-flash',
    promptVersion: 'v1',
    createdAt: Date.UTC(2026, 9, 1),
    fromCache: false,
    usage: { promptTokens: 812, outputTokens: 640 },
  };
}

/** FNV-1a 32-bit hex (deterministic ids for fixtures). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Canned explanations (original example sentences written for Kotori).
// ---------------------------------------------------------------------------

export const CANNED_SPECS: readonly ExplanationSpec[] = [
  {
    sentence: '食べてんじゃねぇよ！',
    translation: '别吃了啊！',
    literal: '（你）不是在吃着吗？——别吃！',
    register: 'rough',
    tone: '不耐烦地制止对方，带点嫌弃',
    ruby: [['食', 'た']],
    chunks: [
      {
        surface: '食べ',
        reading: 'たべ',
        textbookForm: '食べて',
        role: '谓语（动词连用形）',
        meaning: '吃',
        vocab: [{ surface: '食べ', lemma: '食べる', lemmaReading: 'たべる', lemmaRuby: [['食', 'た'], ['べる']], pos: 'verb', meaning: '吃', conjugation: '連用形', jlpt: 'N5', pitch: 2 }],
      },
      {
        surface: 'てんじゃねぇ',
        reading: 'てんじゃねぇ',
        textbookForm: 'ているのではない',
        evolution: {
          kind: '缩约 + 音变',
          derivation: 'ているのではない → てるんじゃない（い脱落、の→ん）→ てんじゃない（る脱落）→ てんじゃねぇ（ない→ねぇ，ai→ee 粗鲁音变）',
          formality: 0.1,
        },
        role: '补助表达：进行体 + 否定的说明语气',
        meaning: '不是正在……吗 → 表示责备「别再……了」',
        nuance: '男性化、粗鲁的口语，常见于斥责或吐槽',
        vocab: [{ surface: 'てん', lemma: 'ている', lemmaReading: 'ている', pos: 'auxiliary', meaning: '正在……（进行体）', conjugation: 'ている → てる → てん', jlpt: 'N5' }],
      },
      {
        surface: 'よ',
        reading: 'よ',
        role: '终助词',
        meaning: '加强语气，向对方强调',
        vocab: [{ surface: 'よ', lemma: 'よ', lemmaReading: 'よ', pos: 'particle', meaning: '（强调/提醒）', jlpt: 'N5' }],
      },
    ],
    grammar: [
      { pattern: '〜ているのではない', chunks: ['てんじゃねぇ'], explanation: '「のではない」用于否定对方的状态或行为，口语中常缩约为「んじゃない」，语气为责备或劝阻。', jlpt: 'N3' },
      { pattern: '〜じゃねぇ（〜じゃない的粗俗音变）', chunks: ['てんじゃねぇ'], explanation: '「ない」的 ai 音在关东男性粗口中常变为 ee：ない→ねぇ，すごい→すげぇ。', jlpt: 'N2' },
    ],
  },
  {
    sentence: 'ちょっと待ってくれよ、まだ話は終わってないんだから。',
    translation: '等一下嘛，我话还没说完呢。',
    register: 'casual',
    tone: '略带急切地挽留对方',
    ruby: [['待', 'ま'], ['話', 'はなし'], ['終', 'お']],
    chunks: [
      { surface: 'ちょっと', reading: 'ちょっと', role: '副词（状语）', meaning: '稍微；一下', nuance: '用于请求时缓和语气', vocab: [{ surface: 'ちょっと', lemma: 'ちょっと', lemmaReading: 'ちょっと', pos: 'adverb', meaning: '稍微，一点', jlpt: 'N5', pitch: 1 }] },
      {
        surface: '待ってくれよ',
        reading: 'まってくれよ',
        textbookForm: '待ってください',
        evolution: { kind: '敬语降级', derivation: '待ってください（礼貌）→ 待ってくれ（男性简体命令）+ よ（强调）', formality: 0.3 },
        role: '谓语（请求）',
        meaning: '等等我啊',
        vocab: [
          { surface: '待っ', lemma: '待つ', lemmaReading: 'まつ', lemmaRuby: [['待', 'ま'], ['つ']], pos: 'verb', meaning: '等待', conjugation: '促音便（待ち→待っ）+ て', jlpt: 'N5', pitch: 1 },
          { surface: 'くれ', lemma: 'くれる', lemmaReading: 'くれる', pos: 'auxiliary', meaning: '（为我）做……', conjugation: '命令形', jlpt: 'N4', pitch: 0 },
        ],
      },
      { surface: 'まだ', reading: 'まだ', role: '副词', meaning: '还，尚未', vocab: [{ surface: 'まだ', lemma: 'まだ', lemmaReading: 'まだ', pos: 'adverb', meaning: '还（没）', jlpt: 'N5', pitch: 1 }] },
      { surface: '話は', reading: 'はなしは', role: '主题', meaning: '话（这件事）', vocab: [{ surface: '話', lemma: '話', lemmaReading: 'はなし', lemmaRuby: [['話', 'はなし']], pos: 'noun', meaning: '话，谈话', jlpt: 'N5', pitch: 3 }] },
      {
        surface: '終わってないんだから',
        reading: 'おわってないんだから',
        textbookForm: '終わっていないのだから',
        evolution: { kind: 'い脱落 + の→ん', derivation: '終わっていないのだから → 終わってないのだから（い脱落）→ 終わってないんだから（の→ん）', formality: 0.35 },
        role: '谓语 + 理由',
        meaning: '因为还没结束嘛',
        nuance: '「んだから」带有「你也该明白」的催促语感',
        vocab: [{ surface: '終わっ', lemma: '終わる', lemmaReading: 'おわる', lemmaRuby: [['終', 'お'], ['わる']], pos: 'verb', meaning: '结束', conjugation: '促音便 + ている + 否定', jlpt: 'N5', pitch: 0 }],
      },
    ],
    grammar: [
      { pattern: '〜てくれ', chunks: ['待ってくれよ'], explanation: '「てくれる」的命令形，男性对平辈或晚辈的直接请求。', jlpt: 'N4' },
      { pattern: '〜んだから', chunks: ['終わってないんだから'], explanation: '说明理由并暗含「所以你应该……」的主张。', jlpt: 'N3' },
    ],
  },
  {
    sentence: '俺は絶対に諦めないからな',
    translation: '我是绝对不会放弃的！',
    register: 'casual',
    tone: '坚定的宣言',
    ruby: [['俺', 'おれ'], ['絶対', 'ぜったい'], ['諦', 'あきら']],
    chunks: [
      { surface: '俺は', reading: 'おれは', role: '主题', meaning: '我（男性粗犷自称）', vocab: [{ surface: '俺', lemma: '俺', lemmaReading: 'おれ', lemmaRuby: [['俺', 'おれ']], pos: 'pronoun', meaning: '我（男性用语）', jlpt: 'N4', pitch: 0 }] },
      { surface: '絶対に', reading: 'ぜったいに', role: '副词（状语）', meaning: '绝对', vocab: [{ surface: '絶対', lemma: '絶対', lemmaReading: 'ぜったい', lemmaRuby: [['絶対', 'ぜったい']], pos: 'na-adjective', meaning: '绝对', jlpt: 'N3', pitch: 0 }] },
      { surface: '諦めない', reading: 'あきらめない', role: '谓语（否定）', meaning: '不放弃', vocab: [{ surface: '諦め', lemma: '諦める', lemmaReading: 'あきらめる', lemmaRuby: [['諦', 'あきら'], ['める']], pos: 'verb', meaning: '放弃，死心', conjugation: 'ない形', jlpt: 'N3', pitch: 4 }] },
      { surface: 'からな', reading: 'からな', role: '句末宣言', meaning: '……你给我记着', nuance: '「からな」表示强烈的决心或警告，男性口吻', vocab: [{ surface: 'から', lemma: 'から', lemmaReading: 'から', pos: 'particle', meaning: '（宣言/警告）', jlpt: 'N4' }] },
    ],
    grammar: [{ pattern: '〜からな', chunks: ['からな'], explanation: '句末「から」+「な」，宣告决心或警告对方。', jlpt: 'N3' }],
  },
  {
    sentence: 'お前のことなんか、ぜんぜん気にしてねーし。',
    translation: '我才一点都不在意你呢。',
    register: 'rough',
    tone: '傲娇式的嘴硬',
    ruby: [['前', 'まえ'], ['気', 'き']],
    chunks: [
      { surface: 'お前のことなんか', reading: 'おまえのことなんか', role: '宾语（轻视）', meaning: '你这种人（的事）', nuance: '「なんか」表示轻视、不屑', vocab: [{ surface: 'お前', lemma: 'お前', lemmaReading: 'おまえ', lemmaRuby: [['お'], ['前', 'まえ']], pos: 'pronoun', meaning: '你（粗鲁）', jlpt: 'N4', pitch: 0 }, { surface: 'なんか', lemma: 'なんか', lemmaReading: 'なんか', pos: 'particle', meaning: '之类的（轻视）', jlpt: 'N3' }] },
      { surface: 'ぜんぜん', reading: 'ぜんぜん', role: '副词', meaning: '完全（不）', vocab: [{ surface: 'ぜんぜん', lemma: '全然', lemmaReading: 'ぜんぜん', lemmaRuby: [['全然', 'ぜんぜん']], pos: 'adverb', meaning: '完全，一点也（不）', jlpt: 'N4', pitch: 0 }] },
      {
        surface: '気にしてねーし',
        reading: 'きにしてねーし',
        textbookForm: '気にしていないし',
        evolution: { kind: '缩约 + 长音化', derivation: '気にしていない → 気にしてない（い脱落）→ 気にしてねー（ない→ねー）+ し（列举理由，口语中表嘴硬）', formality: 0.1 },
        role: '谓语',
        meaning: '才不在意呢',
        vocab: [{ surface: '気にし', lemma: '気にする', lemmaReading: 'きにする', lemmaRuby: [['気', 'き'], ['にする']], pos: 'expression', meaning: '在意，介意', conjugation: 'て形 + いる + 否定', jlpt: 'N4' }],
      },
    ],
    grammar: [
      { pattern: '〜なんか', chunks: ['お前のことなんか'], explanation: '接名词后表示轻视或谦逊。', jlpt: 'N3' },
      { pattern: '〜し（句末）', chunks: ['気にしてねーし'], explanation: '年轻人口语中句末「し」带有反驳、嘴硬的语气。', jlpt: 'N3' },
    ],
  },
  {
    sentence: '行かなきゃ',
    translation: '我得走了。',
    register: 'casual',
    ruby: [['行', 'い']],
    chunks: [
      {
        surface: '行かなきゃ',
        reading: 'いかなきゃ',
        textbookForm: '行かなければならない',
        evolution: { kind: '缩约', derivation: '行かなければならない → 行かなければ（省略后半）→ 行かなきゃ（ければ→きゃ）', formality: 0.3 },
        role: '谓语（义务）',
        meaning: '必须去',
        vocab: [{ surface: '行か', lemma: '行く', lemmaReading: 'いく', lemmaRuby: [['行', 'い'], ['く']], pos: 'verb', meaning: '去', conjugation: '未然形 + なきゃ', jlpt: 'N5', pitch: 0 }],
      },
    ],
    grammar: [{ pattern: '〜なきゃ', chunks: ['行かなきゃ'], explanation: '「なければならない」的口语缩约，表示「必须……」。', jlpt: 'N4' }],
  },
  // --- Dictionary showcase (MockPlatformHost.dict fixtures cover this vocabulary) ---
  {
    sentence: 'バンドの女子、ひとりで全部食べたって言ってた。',
    translation: '乐队的那个女生说，她一个人全吃光了。',
    register: 'casual',
    tone: '转述传闻，略带惊讶',
    ruby: [['女子', 'じょし'], ['全部', 'ぜんぶ'], ['食', 'た'], ['言', 'い']],
    chunks: [
      { surface: 'バンドの', reading: 'ばんどの', role: '定语', meaning: '乐队的', vocab: [{ surface: 'バンド', lemma: 'バンド', lemmaReading: 'バンド', pos: 'noun', meaning: '乐队' }] },
      {
        surface: '女子',
        reading: 'じょし',
        role: '主语（话题）',
        meaning: '女生',
        vocab: [{ surface: '女子', lemma: '女子', lemmaReading: 'じょし', lemmaRuby: [['女子', 'じょし']], pos: 'noun', meaning: '女生', notes: '年轻人口语中泛指同龄女生，带亲近感' }],
      },
      { surface: 'ひとりで', reading: 'ひとりで', role: '状语', meaning: '一个人', vocab: [{ surface: 'ひとり', lemma: 'ひとり', lemmaReading: 'ひとり', pos: 'noun', meaning: '一个人，独自' }] },
      { surface: '全部', reading: 'ぜんぶ', role: '状语', meaning: '全部' },
      {
        surface: '食べたって',
        reading: 'たべたって',
        textbookForm: '食べたと',
        evolution: { kind: '引用缩约', derivation: '食べたと（言っていた）→ 食べたって（と→って，口语引用）', formality: 0.3 },
        role: '引用内容',
        meaning: '（说）吃了',
        vocab: [{ surface: '食べた', lemma: '食べる', lemmaReading: 'たべる', lemmaRuby: [['食', 'た'], ['べる']], pos: 'verb', meaning: '吃', conjugation: 'た形（过去）' }],
      },
      {
        surface: '言ってた',
        reading: 'いってた',
        textbookForm: '言っていた',
        evolution: { kind: 'い脱落', derivation: '言っていた → 言ってた（ている的い脱落）', formality: 0.3 },
        role: '谓语',
        meaning: '（她）说过',
        vocab: [{ surface: '言っ', lemma: '言う', lemmaReading: 'いう', lemmaRuby: [['言', 'い'], ['う']], pos: 'verb', meaning: '说', conjugation: '促音便 + ていた → てた' }],
      },
    ],
    grammar: [{ pattern: '〜って（引用）', chunks: ['食べたって'], explanation: '「と」的口语形，用于转述别人说的话。', jlpt: 'N4' }],
  },
  {
    sentence: '命をかけても守りたいって、そう感じたんだ。',
    translation: '就算豁出性命也想守护——我是这么觉得的。',
    register: 'casual',
    tone: '真挚、下定决心',
    ruby: [['命', 'いのち'], ['守', 'まも'], ['感', 'かん']],
    chunks: [
      { surface: '命を', reading: 'いのちを', role: '宾语', meaning: '性命', vocab: [{ surface: '命', lemma: '命', lemmaReading: 'いのち', lemmaRuby: [['命', 'いのち']], pos: 'noun', meaning: '性命' }] },
      {
        surface: 'かけても',
        reading: 'かけても',
        role: '让步条件',
        meaning: '即使豁出去',
        vocab: [{ surface: 'かけ', lemma: 'かける', lemmaReading: 'かける', pos: 'verb', meaning: '豁出去，拼一把', conjugation: 'て形 + も（即使）', notes: '原句为假名表记，常与「命を」搭配表示孤注一掷' }],
      },
      {
        surface: '守りたいって',
        reading: 'まもりたいって',
        role: '引用内容',
        meaning: '想守护',
        vocab: [{ surface: '守り', lemma: '守る', lemmaReading: 'まもる', lemmaRuby: [['守', 'まも'], ['る']], pos: 'verb', meaning: '守护', conjugation: '連用形 + たい' }],
      },
      { surface: 'そう', reading: 'そう', role: '副词', meaning: '那样' },
      {
        surface: '感じたんだ',
        reading: 'かんじたんだ',
        textbookForm: '感じたのだ',
        role: '谓语（说明）',
        meaning: '感觉到了',
        vocab: [{ surface: '感じ', lemma: '感じる', lemmaReading: 'かんじる', lemmaRuby: [['感', 'かん'], ['じる']], pos: 'verb', meaning: '感觉到', conjugation: 'た形 + んだ' }],
      },
    ],
    grammar: [{ pattern: '〜ても', chunks: ['かけても'], explanation: '表示让步：「即使……也……」。', jlpt: 'N4' }],
  },
  {
    sentence: '人生を賭けた勝負だって、わかってる。',
    translation: '我知道，这是赌上人生的一战。',
    register: 'casual',
    tone: '冷静而坚定',
    ruby: [['人生', 'じんせい'], ['賭', 'か'], ['勝負', 'しょうぶ']],
    chunks: [
      { surface: '人生を', reading: 'じんせいを', role: '宾语', meaning: '人生' },
      {
        surface: '賭けた',
        reading: 'かけた',
        role: '定语（连体修饰）',
        meaning: '赌上的',
        vocab: [{ surface: '賭けた', lemma: '賭ける', lemmaReading: 'かける', lemmaRuby: [['賭', 'か'], ['ける']], pos: 'verb', meaning: '赌上，押上', conjugation: 'た形（连体修饰）', notes: '常构成「命を賭ける」，带有孤注一掷的悲壮决心' }],
      },
      { surface: '勝負だって', reading: 'しょうぶだって', role: '引用内容', meaning: '（是一场）较量' },
      {
        surface: 'わかってる',
        reading: 'わかってる',
        textbookForm: 'わかっている',
        evolution: { kind: 'い脱落', derivation: 'わかっている → わかってる', formality: 0.35 },
        role: '谓语',
        meaning: '明白',
        vocab: [{ surface: 'わかっ', lemma: '分かる', lemmaReading: 'わかる', lemmaRuby: [['分', 'わ'], ['かる']], pos: 'verb', meaning: '明白，知道', conjugation: '促音便 + ている → てる' }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Heuristic generator for sentences without a canned entry.
// ---------------------------------------------------------------------------

const PARTICLE_SPLIT = /(は|が|を|に|で|と|も|へ|から|まで|より|って|けど|ね|よ|な|の|、|。|！|？|!|\?|\n)/u;
const KANJI_RUN = /[\u4e00-\u9fff々]+/gu;
const PUNCT = /^[、。！？!?\s「」『』…・]+$/u;

/** Split a sentence into rough chunks ending at particles; punctuation is never chunked. */
export function heuristicChunks(sentence: string): { surface: string; start: number }[] {
  const parts = sentence.split(PARTICLE_SPLIT).filter((p) => p.length > 0);
  const out: { surface: string; start: number }[] = [];
  let pos = 0;
  let current = '';
  let currentStart = 0;
  const flush = (): void => {
    if (current && !PUNCT.test(current)) out.push({ surface: current, start: currentStart });
    current = '';
  };
  for (const p of parts) {
    if (PUNCT.test(p)) {
      flush();
      pos += p.length;
      currentStart = pos;
      continue;
    }
    if (!current) currentStart = pos;
    current += p;
    pos += p.length;
    if (PARTICLE_SPLIT.test(p) && current.length > p.length) flush();
    else if (current.length >= 6) flush();
    if (!current) currentStart = pos;
  }
  flush();
  return out;
}

/** Plausible explanation for any sentence (mock only — no real NLP). */
export function generateExplanation(sentence: string, targetLanguage: TargetLanguage): SentenceExplanation {
  const chunks = heuristicChunks(sentence);
  const rubySpec: [string, string?][] = [];
  for (const m of sentence.matchAll(KANJI_RUN)) rubySpec.push([m[0], '・'.repeat(Math.min(3, m[0].length * 2))]);
  const zh = targetLanguage !== 'en';
  return defineExplanation(
    {
      sentence,
      translation: zh ? `（模拟翻译）「${sentence.replace(/\n/g, ' ')}」` : `(mock translation) "${sentence.replace(/\n/g, ' ')}"`,
      register: 'plain',
      tone: zh ? 'MockPlatformHost 生成的示例解析' : 'Sample breakdown generated by MockPlatformHost',
      ruby: rubySpec,
      chunks: chunks.map((c, i) => ({
        surface: c.surface,
        reading: c.surface,
        role: zh ? (i === chunks.length - 1 ? '谓语' : '成分') : i === chunks.length - 1 ? 'predicate' : 'constituent',
        meaning: zh ? `「${c.surface}」的含义（模拟）` : `meaning of “${c.surface}” (mock)`,
        vocab: [{ surface: c.surface, lemma: c.surface, lemmaReading: c.surface, pos: 'expression' as const, meaning: zh ? '（模拟词条）' : '(mock entry)' }],
      })),
    },
    targetLanguage,
  );
}

const cannedBySentence = new Map(CANNED_SPECS.map((s) => [s.sentence, s] as const));

/** Canned explanation when available, otherwise generated. */
export function explanationFor(sentence: string, targetLanguage: TargetLanguage): SentenceExplanation {
  const spec = cannedBySentence.get(sentence);
  return spec ? defineExplanation(spec, targetLanguage) : generateExplanation(sentence, targetLanguage);
}
