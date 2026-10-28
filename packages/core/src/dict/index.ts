/**
 * @kotori/core/dict — pure-TS Yomitan v3 dictionary engine (spec:
 * kotori_dictionary_design_proposal §4). Platform-neutral; hosts own storage.
 *
 *   - json-row-stream.ts   JsonArrayRowSplitter / streamJsonArrayRows — byte-level row streaming
 *   - zh-script.ts         katakanaToHiragana, isAllKana, hasKanji, normalizeZhScript (繁→简)
 *   - yomitan-parser.ts    ZIP entry routing, index.json, term / meta rows, MetaRowAccumulator
 *   - lemma-ruby.ts        computeLemmaRuby + JUKUJIKUN_READINGS
 *   - disambiguate.ts      enrichSingleVocab / enrichVocabBatch (render-time enrichment)
 *   - clean-deinflector.ts clean-room MIT deinflector + scanPrefixDeinflections
 *   - instant-lookup.ts    buildInstantLookupMatches / lookupPrefixBatch
 *   - presets.ts           RECOMMENDED_DICT_PRESETS
 */
export * from './json-row-stream';
export * from './zh-script';
export * from './yomitan-parser';
export * from './lemma-ruby';
export * from './disambiguate';
export * from './clean-deinflector';
export * from './instant-lookup';
export * from './presets';
