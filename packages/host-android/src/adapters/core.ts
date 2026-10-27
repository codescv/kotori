/**
 * Core runtime adapter for `@kotori/host-android`.
 *
 * Single seam between the Android host and `@kotori/core` runtime code: every
 * host module imports core *functions* from here (types come straight from
 * `@kotori/core`). Originally this file held local fallbacks while core was
 * implemented in parallel; it now re-exports the real implementations.
 */
export {
  KotoriError,
  // util
  compareNatural,
  // subtitle
  parseSubtitle,
  applyDelay,
  parseEpisodeName,
  detectSubtitleLanguageFromName,
  // manga
  parseMokuro,
  resolveMokuroPageRoot,
  mokuroPageRootCandidates,
  joinMokuroPageRoot,
  parseVolumeName,
  ARCHIVE_IMAGE_EXTENSIONS,
  listArchiveImages,
  readArchiveEntry,
  readImageSize,
  // acquire
  createJimakuClient,
  matchJimakuFilesToEpisodes,
  parseMokuroMoeListing,
  resolveMokuroCatalogUrl,
  buildNyaaRssUrl,
  buildNyaaSearchUrl,
  parseNyaaRss,
  parseNyaaSearchHtml,
  sortNyaaItems,
  mergeNyaaItems,
  buildNyaaMagnet,
  parseMagnet,
  // ai
  PROMPT_VERSION,
  explanationCacheKey,
  createGeminiClient,
  resolveAccessTokenProvider,
  createExplainService,
  testAiConnection,
  ocrBubble,
  pageGuide,
} from '@kotori/core';
export type {
  ArchiveImageEntry,
  MokuroDocument,
  JimakuClient,
  JimakuClientOptions,
  GeminiClient,
  GeminiRequest,
  GeminiResponse,
  ExplanationCache,
  ExplainService,
} from '@kotori/core';

// Host glue: AiApi + testAi over the core explain service.
export { createAiEngine, type AiEngine, type AiEngineDeps } from './ai-engine';
