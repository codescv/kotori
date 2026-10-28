/**
 * Recommended dictionary catalogue (spec §3.2). Only sources with a clear
 * licence or a public free direct download are listed; attribution strings
 * are shown verbatim in the settings UI. Commercial dictionaries are never
 * named or linked — users import any other Yomitan v3 `.zip` generically.
 */
import type { RecommendedDictPreset } from '../types';

const WTY_BASE = 'https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest';
const JMDICT_BASE = 'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download';

export const RECOMMENDED_DICT_PRESETS: readonly RecommendedDictPreset[] = [
  {
    id: 'wty-ja-zh',
    title: 'Wiktionary 日中词典 (wty-ja-zh)',
    description: '日中主词典：中文核心释义与双语例句（187,449 行，含 7.4 万条重定向；释义统一繁转简）。',
    kind: 'term',
    sizeLabel: '6.9 MB',
    license: 'CC BY-SA 4.0',
    attribution: 'Wiktionary / Kaikki.org / yomidevs wty contributors',
    downloadUrl: `${WTY_BASE}/dict/ja/zh/wty-ja-zh.zip`,
    indexUrl: `${WTY_BASE}/index/wty-ja-zh-index.json?download=true`,
    isUpdatable: true,
  },
  {
    id: 'kanjium-pitch',
    title: 'Kanjium 日语音高重音词典',
    description: '权威东京音高核位置（124,137 条，term_meta_bank pitch），区分同形异调。静态归档版本 pitch1。',
    kind: 'pitch',
    sizeLabel: '1.07 MB',
    license: 'CC BY-SA 4.0',
    attribution: 'Uros Ozvatic (Kanjium), EDRDG, packaged by toasted-nutbread',
    downloadUrl: 'https://github.com/toasted-nutbread/yomichan-pitch-accent-dictionary/releases/download/1.0.0/kanjium_pitch_accents.zip',
    isUpdatable: false,
  },
  {
    id: 'jmdict-en',
    title: 'JMdict (English)',
    description: '英文兜底词典：规范假名读音、标准词性标签与共享 sequence 编号，补齐日常口语词。',
    kind: 'term',
    sizeLabel: '15.6 MB',
    license: 'CC BY-SA 4.0',
    attribution: 'Electronic Dictionary Research and Development Group (EDRDG) / yomidevs',
    downloadUrl: `${JMDICT_BASE}/JMdict_english.zip`,
    indexUrl: `${JMDICT_BASE}/JMdict_english.json`,
    isUpdatable: true,
  },
  {
    id: 'jitendex',
    title: 'Jitendex',
    description: '基于 JMdict 增强的富格式日英词典，含更丰富的用法说明与例句。',
    kind: 'term',
    sizeLabel: '38.8 MB',
    license: 'CC BY-SA 4.0',
    attribution: 'Stephen Kraus (stephenmk) & EDRDG',
    downloadUrl: 'https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip',
    // Update endpoint is declared by the package's own index.json.
    isUpdatable: true,
  },
  {
    id: 'jpdb-freq',
    title: 'JPDB v2.2 动漫词频 (JPDBv2㋕)',
    description: '基于 jpdb.io 动漫/轻小说/VN 语料的词频排名（338,814 行），区分汉字表记与假名表记（㋕）词频。',
    kind: 'freq',
    sizeLabel: '6.0 MB',
    license: '免费外部语料数据（无开源许可证）',
    attribution: 'Data from jpdb.io, packaged by Kuuuube & Gecko',
    downloadUrl: 'https://github.com/Kuuuube/yomitan-dictionaries/raw/main/dictionaries/JPDB_v2.2_Frequency_Kana_2024-10-13.zip',
    isUpdatable: false,
    externalOnly: true,
  },
];

/** Preset by id (`undefined` when unknown). */
export function findDictPreset(id: string): RecommendedDictPreset | undefined {
  return RECOMMENDED_DICT_PRESETS.find((p) => p.id === id);
}
