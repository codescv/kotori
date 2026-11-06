/**
 * 「缓存AI解读」 sentence collection with 100 % cache-key parity.
 *
 * Every request built here MUST be identical (sentence + targetLanguage, the
 * only cache-key inputs besides model / prompt version) to what a manual
 * click builds:
 * - subtitles: `useSubtitleBreakdown.openCue` (Japanese line of the merged
 *   `TranscriptRow`, shared `subtitleExplainContext` window, series title);
 * - mokuro bubbles: `openBlockBreakdown` (`block.text`, `blockContext`);
 * - raw-page guide bubbles: `Reader.pickGuideBubble` (`bubble.text`, guide
 *   neighbours as context, `speaker`).
 */
import type { ExplainRequest, ExplainSource, Id, MangaPage, MangaPageGuideResult, TargetLanguage, TranscriptRow } from '@kotori/core';
import { cueJapaneseText, subtitleExplainContext, toSubtitleContextRows, type SubtitleContextRow } from '../../lib/cues';
import { blockContext, blocksInReadingOrder } from '../manga/reader/BlockOverlay';

type SubtitleSource = Extract<ExplainSource, { kind: 'subtitle' }>;

const JAPANESE_CHAR_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff々〆ヵヶ]/u;

/**
 * True for any line with real Japanese content: at least 2 meaningful
 * characters once whitespace, punctuation, symbols (`♪`), long-vowel marks and
 * ellipses are stripped, including at least one kana / kanji. Short real lines
 * (`なんで？`, `まじで？`, `行くぞ！`) qualify; `♪～`, `……`, `ーー` do not.
 */
export function isExplainableJapaneseText(text: string): boolean {
  const stripped = text.replace(/[\s\p{P}\p{S}♪〜～ー…・]/gu, '');
  return stripped.length >= 2 && JAPANESE_CHAR_RE.test(stripped);
}

/** Subtitle row → explain request. Mirrors `useSubtitleBreakdown.openCue` exactly. */
export function buildRowExplainRequest(params: {
  readonly row: TranscriptRow;
  readonly rowIndex: number;
  readonly contextRows: readonly SubtitleContextRow[];
  readonly episodeId: Id;
  readonly trackId: Id;
  readonly targetLanguage: TargetLanguage;
  readonly sceneHint?: string | undefined;
}): ExplainRequest {
  const { row, rowIndex, contextRows, episodeId, trackId, targetLanguage, sceneHint } = params;
  const cue = row.cue;
  // Bilingual fansub cues: only the Japanese line is explained (same as a click).
  const text = cueJapaneseText(cue);
  const source: SubtitleSource = {
    kind: 'subtitle',
    episodeId,
    trackId,
    cueIndexes: [cue.index],
    cueCharSpans: [[0, text.length]],
    startMs: cue.startMs,
    endMs: cue.endMs,
  };
  return {
    sentence: text,
    source,
    targetLanguage,
    ...subtitleExplainContext(contextRows, rowIndex),
    ...(sceneHint ? { sceneHint } : {}),
  };
}

/** Every explainable dialogue row of a whole episode track, in transcript order. */
export function collectSubtitleRequests(params: {
  readonly rows: readonly TranscriptRow[];
  readonly episodeId: Id;
  readonly trackId: Id;
  readonly targetLanguage: TargetLanguage;
  readonly sceneHint?: string | undefined;
}): ExplainRequest[] {
  const { rows, episodeId, trackId, targetLanguage, sceneHint } = params;
  const contextRows = toSubtitleContextRows(rows.map((r) => r.cue));
  const out: ExplainRequest[] = [];
  rows.forEach((row, rowIndex) => {
    if (!isExplainableJapaneseText(cueJapaneseText(row.cue))) return;
    out.push(buildRowExplainRequest({ row, rowIndex, contextRows, episodeId, trackId, targetLanguage, sceneHint }));
  });
  return out;
}

/** Every explainable `.mokuro` OCR bubble of the given pages, in Japanese RTL reading order. */
export function collectMangaBlockRequests(params: {
  readonly volumeId: Id;
  readonly pages: readonly MangaPage[];
  readonly targetLanguage: TargetLanguage;
  readonly sceneHint?: string | undefined;
}): ExplainRequest[] {
  const { volumeId, pages, targetLanguage, sceneHint } = params;
  const out: ExplainRequest[] = [];
  for (const page of pages) {
    for (const block of blocksInReadingOrder(page)) {
      if (!isExplainableJapaneseText(block.text)) continue;
      out.push({
        sentence: block.text,
        source: { kind: 'manga', volumeId, pageIndex: page.index, blockIndex: block.index },
        targetLanguage,
        ...blockContext(page, block.index),
        ...(sceneHint ? { sceneHint } : {}),
      });
    }
  }
  return out;
}

/** Explainable bubbles found by `ai.pageGuide` on a raw (OCR-less) page. Mirrors `Reader.pickGuideBubble`. */
export function collectGuideBubbleRequests(params: {
  readonly volumeId: Id;
  readonly page: MangaPage;
  readonly guide: MangaPageGuideResult;
  readonly targetLanguage: TargetLanguage;
  readonly sceneHint?: string | undefined;
}): ExplainRequest[] {
  const { volumeId, page, guide, targetLanguage, sceneHint } = params;
  const ordered = [...guide.bubbles].sort((x, y) => x.order - y.order);
  const line = (b: (typeof ordered)[number]): string => (b.speaker ? `[${b.speaker}] ${b.text}` : b.text);
  const out: ExplainRequest[] = [];
  ordered.forEach((b, gi) => {
    const block = b.blockIndex !== undefined ? page.blocks.find((x) => x.index === b.blockIndex) : undefined;
    const sentence = block ? block.text : b.text;
    if (!isExplainableJapaneseText(sentence)) return;
    out.push({
      sentence,
      source: block ? { kind: 'manga', volumeId, pageIndex: page.index, blockIndex: block.index } : { kind: 'manga', volumeId, pageIndex: page.index },
      targetLanguage,
      contextBefore: ordered.slice(Math.max(0, gi - 3), gi).map(line),
      contextAfter: ordered.slice(gi + 1, gi + 3).map(line),
      ...(sceneHint ? { sceneHint } : {}),
      ...(b.speaker ? { speaker: b.speaker } : {}),
    });
  });
  return out;
}

/** Context richness used to keep the best occurrence of a repeated sentence. */
function contextScore(r: ExplainRequest): number {
  return (r.contextBefore?.length ?? 0) + (r.contextAfter?.length ?? 0) + (r.speaker ? 1 : 0) + (r.sceneHint ? 1 : 0);
}

/**
 * Deduplicate identical `(sentence, targetLanguage)` pairs — they share one
 * cache key, so explaining a repeated phrase once gives 0 ms hits everywhere
 * it appears. Keeps the occurrence with the richest dialogue context and the
 * first-occurrence order.
 */
export function dedupeBySentence(requests: readonly ExplainRequest[]): ExplainRequest[] {
  const best = new Map<string, { index: number; req: ExplainRequest }>();
  requests.forEach((req, index) => {
    const key = `${req.targetLanguage}\u0000${req.sentence}`;
    const prev = best.get(key);
    if (!prev) best.set(key, { index, req });
    else if (contextScore(req) > contextScore(prev.req)) best.set(key, { index: prev.index, req });
  });
  return [...best.values()].sort((a, b) => a.index - b.index).map((x) => x.req);
}
