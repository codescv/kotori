/**
 * Test-only sample arguments for every routed `PlatformHost` method (used by
 * the route-table round-trip test, the REST client tests and the server
 * route-coverage test).
 */
import type { DownloadRequest, ExplainRequest, FollowUpRequest, ImagePayload, VocabEntry } from '@kotori/core';
import type { RoutedMethodKey, WireArgs } from './routes';

const image: ImagePayload = { mimeType: 'image/png', base64: 'iVBORw0KGgo=', width: 10, height: 10 };
export const sampleExplain: ExplainRequest = {
  sentence: '今日は学校に行きたくない。',
  source: { kind: 'subtitle', episodeId: 'ep_1', trackId: 'tr_1', cueIndexes: [3], cueCharSpans: [[0, 13]], startMs: 1000, endMs: 2000 },
  targetLanguage: 'zh-CN',
  focusCharIndex: 2,
};
export const sampleFollowUp: FollowUpRequest = { explanationId: 'ex_1', history: [], question: 'なぜ？', targetLanguage: 'zh-CN' };
export const sampleDownload: DownloadRequest = { source: { kind: 'http', url: 'https://example.com/a.zip', fileName: 'a.zip' }, autoImport: false };

export const sampleVocab: VocabEntry = {
  id: 'v0',
  charSpan: [0, 3],
  alignment: 'exact',
  surface: '言った',
  lemma: '言う',
  lemmaReading: 'いう',
  lemmaRuby: [],
  partOfSpeech: 'verb',
  meaning: '说',
};

export const SAMPLE_ARGS: { readonly [K in RoutedMethodKey]: WireArgs<K> } = {
  'settings.get': [],
  'settings.update': [{ ui: { theme: 'dark' } }],
  'settings.testAi': [],
  'anime.listSeries': [],
  'anime.getSeries': ['sr_1'],
  'anime.listEpisodes': ['sr_1'],
  'anime.getEpisode': ['ep_1'],
  'anime.importSeries': [{ path: '/tmp/anime', titleOverride: 'Show' }],
  'anime.updateSeries': ['sr_1', { title: 'Updated' }],
  'anime.removeSeries': ['sr_1', true],
  'anime.rescanSeries': ['sr_1'],
  'anime.getCues': ['tr_1'],
  'anime.addSubtitleTrack': ['ep_1', { content: '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n', fileName: 'a.ja.srt', language: 'ja' }],
  'anime.extractEmbeddedTrack': ['ep_1', 2],
  'anime.removeSubtitleTrack': ['tr_1'],
  'anime.setTrackDelay': ['tr_1', -250],
  'anime.setDefaultTrack': ['ep_1', 'tr_1'],
  'anime.saveProgress': ['ep_1', { positionMs: 1000, durationMs: 1440000, updatedAt: 1700000000000 }],
  'anime.autoFetchJimaku': ['sr_1', { entryId: 42 }],
  'manga.listVolumes': [],
  'manga.getVolume': ['mv_1'],
  'manga.importVolume': [{ path: '/tmp/manga/vol1.mokuro' }],
  'manga.removeVolume': ['mv_1', false],
  'manga.getPage': ['mv_1', 4],
  'manga.getPages': ['mv_1'],
  'manga.setReadingMode': ['mv_1', 'single-rtl'],
  'manga.setCoverIsSingle': ['mv_1', false],
  'manga.saveProgress': ['mv_1', { pageIndex: 3, updatedAt: 1700000000000 }],
  'manga.addBlocks': [
    'mv_1',
    0,
    [{ rect: { left: 1, top: 2, right: 30, bottom: 40 }, vertical: true, fontSize: 20, zIndex: 0, lines: ['あ', 'い'], text: 'あい', source: 'vlm' }],
  ],
  'ai.explain': [sampleExplain],
  'ai.explainBatch': [[sampleExplain]],
  'ai.getCachedExplanation': [sampleExplain],
  'ai.followUp': [sampleFollowUp],
  'ai.followUpStream': [sampleFollowUp],
  'ai.ocrBubble': [{ volumeId: 'mv_1', pageIndex: 0, rect: { left: 0, top: 0, right: 10, bottom: 10 }, image, explain: true, targetLanguage: 'en' }],
  'ai.pageGuide': [{ volumeId: 'mv_1', pageIndex: 0, image, targetLanguage: 'en' }],
  'ai.getThread': ['ex_1'],
  'ai.clearCache': [],
  'downloads.searchNyaa': [{ query: 'frieren', category: '1_4', filter: 'trusted-only', sort: 'seeders' }],
  'downloads.searchJimaku': [{ query: 'Frieren' }],
  'downloads.listJimakuFiles': [42, 3],
  'downloads.browseMokuroCatalog': ['https://mokuro.moe/manga/Foo/'],
  'downloads.list': [],
  'downloads.get': ['dl_1'],
  'downloads.start': [sampleDownload],
  'downloads.pause': ['dl_1'],
  'downloads.resume': ['dl_1'],
  'downloads.cancel': ['dl_1'],
  'downloads.remove': ['dl_1', true],
  'downloads.selectFiles': ['dl_1', [0, 2]],
  'files.listDirectory': ['/tmp'],
  'files.openExternal': ['magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'],
  'dict.list': [],
  'dict.importZip': [{ filePath: '/nonexistent/kotori-test-dict.zip', fileName: 'kotori-test-dict.zip', attribution: 'test' }],
  'dict.update': ['dict_1', { enabled: false, priority: 2 }],
  'dict.remove': ['dict_1'],
  'dict.enrichVocab': [[sampleVocab]],
  'dict.lookupPrefix': ['言っちゃった', 8],
};
