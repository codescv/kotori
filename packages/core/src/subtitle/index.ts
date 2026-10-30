/**
 * @kotori/core/subtitle — SRT / VTT / ASS engine.
 *
 * Owner: coder-1. Modules (see ARCHITECTURE.md §4.2):
 *   - detect.ts         decodeSubtitleBytes(bytes) → { text, encoding }, detectSubtitleFormat(text, fileName?)
 *   - srt.ts            parseSrt(text), stripSubtitleHtml(raw)
 *   - vtt.ts            parseVtt(text)
 *   - ass.ts            parseAss(text), stripAssTags(raw), parseAssMarkup(event, scriptInfo)
 *   - parse.ts          parseSubtitle(input) — decode + format sniff + dispatch
 *   - merge-per-char.ts mergePerCharacterCueGroups(cues) → MergedCueGroups
 *   - transcript.ts     buildTranscriptRows(cues, options) → TranscriptRow[], isSignCue, matchSecondaryCuesToRows
 *   - cue-utils.ts      cueIndexAt, activeCueIndexes, nextCueIndex, prevCueIndex, applyDelay, sortCuesByStart,
 *                       mergeCuesToSentence, cueOffsetToSentenceIndex, sentenceIndexToCueOffset,
 *                       splitBilingualCueText, dropDuplicateLines, translationTextOf, isBilingualTrack
 *   - episode-name.ts   parseEpisodeName(fileName) → ParsedEpisodeName
 *   - language.ts       detectSubtitleLanguageFromName(fileName), normalizeLanguageTag(tag) → LanguageTag | undefined
 */
export * from './detect';
export { normalizeJapaneseKana, parseSrt, stripSubtitleHtml } from './srt';
export * from './vtt';
export * from './ass';
export * from './parse';
export * from './merge-per-char';
export * from './transcript';
export * from './cue-utils';
export * from './episode-name';
export * from './language';
