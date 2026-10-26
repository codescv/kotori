/**
 * @kotori/core/subtitle — SRT / VTT / ASS engine.
 *
 * Owner: coder-1. Planned modules (see ARCHITECTURE.md §4.2):
 *   - detect.ts         detectSubtitleFormat(bytes|text), decodeSubtitleBytes(bytes) → { text, encoding }
 *                       (UTF-8 BOM / UTF-16 / Shift_JIS via TextDecoder('shift_jis'))
 *   - srt.ts            parseSrt(text) → ParsedSubtitleTrack
 *   - vtt.ts            parseVtt(text) → ParsedSubtitleTrack
 *   - ass.ts            parseAss(text) → ParsedSubtitleTrack (Dialogue + Comment, PlayRes, \pos, \an,
 *                       \move, \fad, \k, \p, layer, style); stripAssTags(raw) → plain text
 *   - parse.ts          parseSubtitle(input) — format sniff + dispatch
 *   - merge-per-char.ts mergePerCharacterCueGroups(cues) → MergedCueGroups
 *   - transcript.ts     buildTranscriptRows(cues, options) → TranscriptRow[] (merge + dedupe + chain fold)
 *   - cue-utils.ts      cueIndexAt(cues, ms), nextCue, prevCue, applyDelay,
 *                       mergeCuesToSentence(cues[]) → { text, startMs, endMs, cueIndexes, cueCharSpans },
 *                       cueOffsetToSentenceIndex(source, cueIndex, localIdx), sentenceIndexToCueOffset(source, idx)
 *   - episode-name.ts   parseEpisodeName(fileName) → ParsedEpisodeName
 *   - language.ts       detectSubtitleLanguageFromName(fileName) → LanguageTag | undefined
 */
export {};
