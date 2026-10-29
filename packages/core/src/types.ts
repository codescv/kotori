/**
 * @kotori/core — shared type contracts.
 *
 * This file is the single source of truth for every data shape that crosses a
 * package boundary (core ⇄ ui ⇄ host-node ⇄ host-android). It is deliberately
 * **types only** (plus a handful of `const` enums-as-unions) so it can be
 * imported from any runtime (browser, Node 22+, Capacitor WebView) with zero
 * side effects.
 *
 * Conventions
 * -----------
 * - All indices into text are **UTF-16 code unit** offsets (JavaScript
 *   `string.length` semantics), never grapheme or code-point indices. Every
 *   `CharSpan` is half-open `[start, end)`.
 * - All times are milliseconds. Wall-clock timestamps are epoch ms (`number`).
 * - All pixel geometry (manga) is in *original page pixels* unless the field
 *   name says `Fraction`/`Normalized` (0..1 relative to the page).
 * - `id` fields are opaque strings chosen by the host; the UI never parses them.
 * - Field names are camelCase in memory. Wire/JSON formats of third parties
 *   (`.mokuro`, Jimaku, Nyaa RSS) are normalised in `@kotori/core` parsers.
 *
 * Ownership
 * ---------
 * Owned by the architecture (designer). Coders MUST NOT edit this file
 * unilaterally; propose additive changes on the swarm board. Additive,
 * optional fields are always safe; renames/removals are breaking.
 */

// ---------------------------------------------------------------------------
// 0. Primitives
// ---------------------------------------------------------------------------

/** Half-open UTF-16 range `[start, end)` into a specific source string. */
export type CharSpan = readonly [start: number, end: number];

/** Opaque identifier chosen by a host (stable across restarts). */
export type Id = string;

/** Epoch milliseconds. */
export type EpochMs = number;

/** ISO-639-1 / BCP-47 language tag, lower-case (`ja`, `en`, `zh-CN`). */
export type LanguageTag = string;

/** Target language for translations / explanations. */
export type TargetLanguage = 'zh-CN' | 'zh-TW' | 'en';

/** Result wrapper used by parsers that should never throw on bad input. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly warnings: readonly string[] };

// ---------------------------------------------------------------------------
// 1. AI & Explanation (Gemini Flash sentence breakdown)
// ---------------------------------------------------------------------------

/**
 * One furigana unit. `base` is a slice of the sentence; `ruby` (hiragana
 * reading) is present only when `base` contains kanji (or other non-kana that
 * needs a reading). Concatenating `base` over a `RubySegment[]` MUST reproduce
 * the covered source text byte-for-byte — the UI relies on this to render
 * `汉字(假名)` / `<ruby>` while keeping click positions mappable.
 */
export interface RubySegment {
  readonly base: string;
  readonly ruby?: string;
  /** Span of `base` inside the owning sentence (UTF-16, half-open). */
  readonly charSpan: CharSpan;
}

/** How a span was aligned back onto the source sentence by `alignSpans()`. */
export type SpanAlignment =
  /** `surface` found verbatim at a monotonic cursor position. */
  | 'exact'
  /** Found after width/whitespace/kana normalisation. */
  | 'fuzzy'
  /**
   * Not found: `charSpan` is an empty span `[p, p)` at the previous chunk's
   * end. The UI shows the chunk but cannot highlight it from a click.
   */
  | 'unaligned';

/**
 * A semantic chunk ("意群") of the sentence — the unit the breakdown panel
 * highlights when the user clicks a character in the subtitle / bubble.
 * Chunks are ordered by `charSpan.start`, non-overlapping, and together
 * (ideally) cover every non-punctuation character of `sentence`.
 */
export interface SemanticChunk {
  readonly id: Id;
  /** Range in `SentenceExplanation.sentence`. */
  readonly charSpan: CharSpan;
  readonly alignment: SpanAlignment;
  /** Exact source slice `sentence.slice(start, end)`. */
  readonly surface: string;
  /** Hiragana reading of `surface`. */
  readonly reading: string;
  /** Furigana segmentation of `surface` (same coordinate space as `charSpan`). */
  readonly ruby: readonly RubySegment[];
  /**
   * 📘 Textbook / dictionary-standard form of this chunk, e.g.
   * `〜ているのではないか` for the spoken `〜てんじゃねぇか`. Equal to
   * `surface` when the chunk is already standard.
   */
  readonly textbookForm: string;
  /**
   * 🔥 Spoken-language evolution: how `textbookForm` became `surface`
   * (contraction, sound change, slang, dialect). `undefined` when
   * `surface === textbookForm` (nothing evolved).
   */
  readonly spokenEvolution?: SpokenEvolution;
  /** Grammatical / discourse role in this sentence (target language prose). */
  readonly role: string;
  /** Meaning of the chunk in context (target language). */
  readonly meaning: string;
  /** Optional nuance / register / politeness note. */
  readonly nuance?: string;
  /** Vocabulary entries whose span lies inside this chunk. */
  readonly vocabIds: readonly Id[];
}

export interface SpokenEvolution {
  /** Short label, e.g. `縮約`, `音便`, `俗语`, `关西腔`. */
  readonly kind: string;
  /** Step-by-step derivation `A → B → C` in target language prose. */
  readonly derivation: string;
  /** Formality 0 (very casual/rough) … 1 (formal/polite). */
  readonly formality?: number;
}

/** Part-of-speech coarse classes understood by the UI (icon / colour). */
export type PartOfSpeech =
  | 'noun'
  | 'verb'
  | 'i-adjective'
  | 'na-adjective'
  | 'adverb'
  | 'particle'
  | 'auxiliary'
  | 'conjunction'
  | 'pronoun'
  | 'counter'
  | 'interjection'
  | 'expression'
  | 'prefix'
  | 'suffix'
  | 'proper-noun'
  | 'onomatopoeia'
  | 'other';

export interface VocabEntry {
  readonly id: Id;
  /** Range of the inflected surface form in the sentence. */
  readonly charSpan: CharSpan;
  readonly alignment: SpanAlignment;
  readonly surface: string;
  /** Dictionary (lemma) form, e.g. `食べる` for `食べちゃった`. */
  readonly lemma: string;
  /** Hiragana reading of `lemma`. */
  readonly lemmaReading: string;
  /** Furigana segmentation of `lemma` (charSpan relative to `lemma`). */
  readonly lemmaRuby: readonly RubySegment[];
  readonly partOfSpeech: PartOfSpeech;
  /** Short gloss in target language. */
  readonly meaning: string;
  /** Inflection path from lemma to surface (e.g. `て形 + しまう → ちゃう + た`). */
  readonly conjugation?: string;
  /** JLPT level N5..N1 when confidently known. */
  readonly jlpt?: 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
  /**
   * Pitch accent pattern index (0 = 平板) when known.
   * @deprecated No longer requested from the model (often wrong, wastes
   * tokens); kept optional so older cached explanations still type-check.
   */
  readonly pitchAccent?: number;
  readonly notes?: string;
}

export interface GrammarPoint {
  readonly id: Id;
  /** Pattern in textbook notation, e.g. `〜ばかりに`. */
  readonly pattern: string;
  /** Chunk ids that instantiate this pattern. */
  readonly chunkIds: readonly Id[];
  readonly explanation: string;
  readonly jlpt?: 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
}

/** Where a sentence came from; used for prompt context + cache scoping. */
export type ExplainSource =
  | {
      readonly kind: 'subtitle';
      readonly episodeId: Id;
      readonly trackId: Id;
      /** Raw cue indexes merged into this sentence (1 or more), in order. */
      readonly cueIndexes: readonly number[];
      /**
       * Parallel to `cueIndexes`: where each cue's `text` sits inside
       * `ExplainRequest.sentence`, so a click at `(cueIndex, localCharIndex)`
       * in the overlay/transcript maps to `cueCharSpans[k][0] + localCharIndex`
       * (see `cueOffsetToSentenceIndex()` in core). A single cue is
       * `[[0, text.length]]`.
       */
      readonly cueCharSpans: readonly CharSpan[];
      readonly startMs: number;
      readonly endMs: number;
    }
  | {
      readonly kind: 'manga';
      readonly volumeId: Id;
      readonly pageIndex: number;
      /** `undefined` when the text came from a free-form VLM OCR selection. */
      readonly blockIndex?: number;
    }
  | { readonly kind: 'manual' };

export interface ExplainRequest {
  /**
   * The exact sentence to explain. The host/UI must pass the *same* string it
   * will later index with `charIndex` (subtitle `SubtitleCue.text`, or manga
   * `MangaBlock.text`). Core never mutates it; alignment works on it verbatim.
   */
  readonly sentence: string;
  readonly source: ExplainSource;
  /** Up to ~3 preceding lines for context (not explained). */
  readonly contextBefore?: readonly string[];
  /** Up to ~2 following lines for context (not explained). */
  readonly contextAfter?: readonly string[];
  /** Free-form scene hint (title, speaker, genre) for better register detection. */
  readonly sceneHint?: string;
  /** UTF-16 index the user clicked; a prompt hint only, never changes output shape. */
  readonly focusCharIndex?: number;
  readonly targetLanguage: TargetLanguage;
  /** Skip cache lookup and force a fresh model call. */
  readonly force?: boolean;
  /** Speaker / actor of the TARGET line (ASS `Name`, manga speaker) — prompt hint only. */
  readonly speaker?: string | undefined;
}

export interface SentenceExplanation {
  /** Stable cache key = hash(sentence, targetLanguage, model, promptVersion). */
  readonly id: Id;
  /** Verbatim copy of `ExplainRequest.sentence`; all spans index into this. */
  readonly sentence: string;
  /** Full-sentence furigana; `ruby[].base` concatenated === `sentence`. */
  readonly ruby: readonly RubySegment[];
  /** Natural translation in `targetLanguage`. */
  readonly translation: string;
  /** Literal / structural gloss, when it differs meaningfully from `translation`. */
  readonly literalTranslation?: string;
  /** Ordered, non-overlapping semantic chunks. */
  readonly chunks: readonly SemanticChunk[];
  readonly vocab: readonly VocabEntry[];
  readonly grammar: readonly GrammarPoint[];
  /** Overall register of the utterance. */
  readonly register?: 'polite' | 'plain' | 'casual' | 'rough' | 'honorific' | 'humble' | 'dialect' | 'literary';
  /** One-line summary of speaker intent / tone. */
  readonly tone?: string;
  /** Optional cultural / ACG / slang / pragmatic note when the line contains a notable reference or trope. */
  readonly culturalNote?: string;
  readonly targetLanguage: TargetLanguage;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: EpochMs;
  readonly fromCache: boolean;
  /** Token usage reported by the API (for the settings page cost meter). */
  readonly usage?: TokenUsage;
  /**
   * True when some model chunks could not be aligned onto `sentence` even
   * after one silent retry; those chunks were dropped. Degraded explanations
   * are never cached, so the next request tries again.
   */
  readonly degraded?: boolean | undefined;
  /**
   * Elements the Japanese leaves implicit but that are essential to the
   * meaning (e.g. `{ text: '私は', role: '省略主语' }`). Absent when nothing
   * important is omitted.
   */
  readonly omitted?: readonly { readonly text: string; readonly role?: string | undefined }[] | undefined;
  /** For merged multi-line dialogue: speaker relationship / register shift / Q&A flow. */
  readonly dialogueRelation?: string | undefined;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
}

/** A message in a follow-up Q&A thread attached to one explanation. */
export interface FollowUpMessage {
  readonly id: Id;
  readonly role: 'user' | 'model';
  /** Markdown-light text (bold, lists, inline code allowed; no HTML). */
  readonly text: string;
  readonly createdAt: EpochMs;
  readonly usage?: TokenUsage;
}

export interface FollowUpRequest {
  readonly explanationId: Id;
  /**
   * The explanation being discussed. The UI always passes it; hosts prefer it
   * over a cache lookup so follow-ups work when `cacheEnabled` is false.
   */
  readonly explanation?: SentenceExplanation;
  /** Prior thread, oldest first. Core prepends the explanation as context. */
  readonly history: readonly FollowUpMessage[];
  readonly question: string;
  readonly targetLanguage: TargetLanguage;
}

/** Streaming chunk for follow-ups (hosts may stream; UI must also accept a single final chunk). */
export interface FollowUpDelta {
  readonly messageId: Id;
  readonly textDelta: string;
  readonly done: boolean;
  readonly usage?: TokenUsage;
}

// --- AI provider settings ---------------------------------------------------

/** Google AI Studio (Gemini Developer API) — authenticated with an API key. */
export interface GeminiApiKeyProvider {
  readonly provider: 'gemini-api';
  readonly apiKey: string;
  /** Override for proxies; default `https://generativelanguage.googleapis.com`. */
  readonly baseUrl?: string;
  /** API version segment; default `v1beta`. */
  readonly apiVersion?: 'v1' | 'v1beta';
}

/** Vertex AI credentials: exactly one strategy. */
export type VertexAuth =
  /** Caller-supplied OAuth2 bearer token (e.g. from `gcloud auth print-access-token`). */
  | { readonly kind: 'access-token'; readonly accessToken: string; readonly expiresAt?: EpochMs }
  /**
   * Application Default Credentials resolved by the host (Node:
   * google-auth-library / gcloud user creds / metadata server). Only offered
   * when `HostCapabilities.vertexAdc` is true (desktop); Android has no ADC.
   */
  | { readonly kind: 'adc' }
  /**
   * Service-account JSON key contents. Exchanged for an OAuth2 token in
   * **core** (`createServiceAccountTokenProvider`: RS256 JWT via
   * `crypto.subtle` + token endpoint `fetch`), so it works identically on
   * desktop and Android.
   */
  | { readonly kind: 'service-account-json'; readonly json: string }
  /** Vertex AI Express mode: API key on the Vertex endpoint, no project needed. */
  | { readonly kind: 'express-api-key'; readonly apiKey: string };

export interface VertexAiProvider {
  readonly provider: 'vertex-ai';
  /** GCP project id (not required for `express-api-key`). */
  readonly project?: string;
  /** Region, e.g. `us-central1`, or `global`. */
  readonly location: string;
  readonly auth: VertexAuth;
  /** Override; default `https://{location}-aiplatform.googleapis.com` (or `https://aiplatform.googleapis.com` for `global`). */
  readonly baseUrl?: string;
}

export type AiProviderSettings = GeminiApiKeyProvider | VertexAiProvider;

/** Customisable persona ("形态设置") for the AI reading/listening companion. */
export interface AiPersonaSettings {
  /** Assistant display nickname (e.g. `小鳥` / `ことり`). */
  readonly name?: string;
  /** Avatar image URL or `data:image/...` data URL. Empty/omitted renders the brand initial (`こ`). */
  readonly avatarUrl?: string;
  /** Persona / character soul instruction injected into follow-up Q&A system prompts. */
  readonly soul?: string;
}

export interface AiSettings {
  readonly provider: AiProviderSettings;
  /** Text model for sentence breakdown / follow-ups, e.g. `gemini-3.8-flash`. */
  readonly explainModel: string;
  /** Multimodal model for manga bubble OCR / page guide, e.g. `gemini-3.8-flash`. */
  readonly visionModel: string;
  /** 0..2; default 0.2 for deterministic breakdowns. */
  readonly temperature: number;
  /** Gemini thinking budget in tokens; `0` disables thinking; `undefined` = model default. */
  readonly thinkingBudget?: number;
  readonly targetLanguage: TargetLanguage;
  /** Persist explanations keyed by `SentenceExplanation.id`. */
  readonly cacheEnabled: boolean;
  /** Per-request timeout. */
  readonly timeoutMs: number;
  /** Optional AI assistant persona (nickname, avatar image, follow-up soul). */
  readonly persona?: AiPersonaSettings;
}

/** Result of `PlatformHost.settings.testAi()`. */
export interface AiConnectionTestResult {
  readonly ok: boolean;
  readonly model: string;
  readonly latencyMs: number;
  readonly message: string;
}

// --- Manga VLM (Gemini vision) -----------------------------------------------

/** Image payload passed to vision calls (cropped by the UI via canvas). */
export interface ImagePayload {
  /** `image/jpeg` | `image/png` | `image/webp`. */
  readonly mimeType: string;
  /** Base64 (no data-URL prefix). */
  readonly base64: string;
  readonly width: number;
  readonly height: number;
}

export interface MangaBubbleOcrRequest {
  readonly volumeId: Id;
  readonly pageIndex: number;
  /** Selection in page pixels. */
  readonly rect: MangaRect;
  /** Crop of `rect` (UI supplies; host may re-crop on desktop if absent). */
  readonly image: ImagePayload;
  /** Also run the sentence breakdown on the recognised text in one round-trip. */
  readonly explain: boolean;
  readonly targetLanguage: TargetLanguage;
}

export interface MangaBubbleOcrResult {
  readonly volumeId: Id;
  readonly pageIndex: number;
  readonly rect: MangaRect;
  /** Recognised lines in reading order (top→bottom for vertical text). */
  readonly lines: readonly string[];
  /** `lines.join('')` — the string explanations index into. */
  readonly text: string;
  readonly vertical: boolean;
  /** Model self-reported confidence 0..1 when available. */
  readonly confidence?: number;
  readonly explanation?: SentenceExplanation;
  readonly model: string;
  readonly createdAt: EpochMs;
  readonly usage?: TokenUsage;
}

export interface MangaPageGuideRequest {
  readonly volumeId: Id;
  readonly pageIndex: number;
  /** Full page image (downscaled by UI to ≤ 1536px long edge). */
  readonly image: ImagePayload;
  readonly targetLanguage: TargetLanguage;
  /** Known OCR blocks (mokuro) to anchor the model; empty for raw images. */
  readonly knownBlocks?: readonly MangaBlock[];
}

export interface MangaGuideBubble {
  /** 1-based reading order on the page (RTL, top→bottom). */
  readonly order: number;
  /** Bubble location, normalised 0..1 relative to the page image. */
  readonly rectFraction: MangaRectFraction;
  /** Index into `knownBlocks` when the model matched an OCR block. */
  readonly blockIndex?: number;
  readonly text: string;
  readonly speaker?: string;
  readonly translation: string;
  /** Short learning note (grammar / slang / cultural). */
  readonly note?: string;
}

export interface MangaPageGuideResult {
  readonly volumeId: Id;
  readonly pageIndex: number;
  readonly bubbles: readonly MangaGuideBubble[];
  /** Scene summary in target language. */
  readonly summary: string;
  readonly model: string;
  readonly createdAt: EpochMs;
  readonly usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// 2. Anime & Subtitles
// ---------------------------------------------------------------------------

export interface AnimeSeries {
  readonly id: Id;
  readonly title: string;
  /** Host-specific root (desktop: absolute dir; Android: content/tree URI). */
  readonly sourcePath: string;
  readonly coverUrl?: string;
  readonly episodeCount: number;
  readonly addedAt: EpochMs;
  readonly lastWatchedEpisodeId?: Id;
  readonly lastWatchedAt?: EpochMs;
  /** Linked Jimaku entry for automatic subtitle download. */
  readonly jimakuEntryId?: number;
  readonly anilistId?: number;
}

export interface PlaybackProgress {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly updatedAt: EpochMs;
}

export type VideoContainer = 'mp4' | 'mkv' | 'webm' | 'other';

export interface AnimeEpisode {
  readonly id: Id;
  readonly seriesId: Id;
  readonly title: string;
  readonly fileName: string;
  /** Host-specific path / URI of the media file. */
  readonly filePath: string;
  readonly container: VideoContainer;
  readonly sizeBytes: number;
  readonly durationMs?: number;
  readonly parsedName: ParsedEpisodeName;
  readonly subtitleTracks: readonly SubtitleTrack[];
  readonly progress?: PlaybackProgress;
  /**
   * URL the `<video>` element can play directly (desktop: `/api/media/{id}`
   * with HTTP Range support; Android: `Capacitor.convertFileSrc(path)`).
   */
  readonly mediaUrl: string;
}

export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export type SubtitleTrackOrigin =
  /** Sidecar file next to the video (`.ja.ass`, `.srt`, …). */
  | 'external'
  /** Text stream inside an MKV, extracted via system ffmpeg (desktop only). */
  | 'embedded'
  /** Downloaded from Jimaku into the host's subtitle store. */
  | 'jimaku'
  /** Manually imported by the user. */
  | 'imported';

export interface SubtitleTrack {
  readonly id: Id;
  readonly episodeId: Id;
  readonly origin: SubtitleTrackOrigin;
  readonly format: SubtitleFormat;
  readonly label: string;
  readonly language?: LanguageTag;
  /** Path of the subtitle file (sidecar / extracted / downloaded). */
  readonly filePath?: string;
  /** ffmpeg stream index for `embedded` tracks (before extraction). */
  readonly streamIndex?: number;
  readonly isDefault: boolean;
  readonly cueCount?: number;
  /** User-applied delay (+ = subtitles later). */
  readonly delayMs: number;
}

/** Normalised `\pos(x,y)` as fractions of PlayResX/PlayResY (0..1). */
export interface SubtitlePosFraction {
  readonly xFraction: number;
  readonly yFraction: number;
}

/**
 * Subset of ASS override-tag / event metadata the app needs. Rendering is
 * plain text (no libass); this exists for (a) `mergePerCharacterCueGroups`
 * (per-character karaoke events) and (b) hiding signs/drawings from the
 * transcript.
 */
export interface AssMarkup {
  /** `Layer` column of the Dialogue event (SRT/VTT ⇒ 0). */
  readonly layer: number;
  /** Style name from the `Style:` column. */
  readonly styleName?: string;
  /** `\an1..9` numpad alignment when present. */
  readonly alignment?: number;
  /** `\pos(x,y)`; absent for normal dialogue. */
  readonly posFraction?: SubtitlePosFraction;
  /** `\move(...)` present (typesetting; excluded from transcript by default). */
  readonly hasMove: boolean;
  /** `\fad`/`\fade` simple form, ms. */
  readonly fade?: { readonly inMs: number; readonly outMs: number };
  /** `\k`/`\kf`/`\ko` karaoke timing tags present. */
  readonly hasKaraoke: boolean;
  /** `\p1` vector drawing event (no readable text). */
  readonly isDrawing: boolean;
  /** `Comment:` event (never displayed). */
  readonly isComment: boolean;
  /** Script `PlayResX`/`PlayResY` (ASS defaults 384×288 when absent). */
  readonly playResX: number;
  readonly playResY: number;
  /** Actor/Name column. */
  readonly actor?: string;
}

export interface SubtitleCue {
  /** Position in the parsed track (stable per file). */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /**
   * Plain text with all tags stripped, `\N`/`\n` → `\n`, `\h` → space, ruby
   * tags (`{\rt}`/`<ruby>`) folded to base text. **This is the string the
   * breakdown indexes** (`ExplainRequest.sentence` for a single cue).
   */
  readonly text: string;
  /** Original payload (for debugging / re-parse). */
  readonly rawText: string;
  /** Present for ASS tracks; `undefined` for SRT/VTT. */
  readonly markup?: AssMarkup;
}

export interface SubtitleTrackInfo {
  readonly format: SubtitleFormat;
  /** Detected text encoding (`utf-8`, `shift_jis`, `utf-16le`, …). */
  readonly encoding: string;
  readonly language?: LanguageTag;
  readonly title?: string;
  readonly styles?: readonly string[];
}

export interface ParsedSubtitleTrack {
  readonly info: SubtitleTrackInfo;
  readonly cues: readonly SubtitleCue[];
  readonly warnings: readonly string[];
}

/**
 * Output of `mergePerCharacterCueGroups()`: ASS per-character karaoke events
 * folded back into whole sentences for the transcript list. Keys are raw cue
 * indexes. The renderer keeps consuming the raw cues; only the transcript uses
 * this view. See ARCHITECTURE.md §4.2 for the exact grouping criteria.
 */
export interface MergedCueGroups {
  /** Representative raw index (group head) → synthesised whole-sentence cue. */
  readonly byRep: ReadonlyMap<number, SubtitleCue>;
  /** Every raw index in a group → its group head's raw index. */
  readonly repByRaw: ReadonlyMap<number, number>;
}

/** One row in the transcript / jump panel after merging & de-duplication. */
export interface TranscriptRow {
  /** Raw index of the representative cue. */
  readonly rep: number;
  readonly cue: SubtitleCue;
  /** All raw indexes that map to this row (karaoke chars, duplicate layers, chains). */
  readonly rawIndexes: readonly number[];
  /** End of an adjacency chain folded into this row (≥ `cue.endMs`). */
  readonly chainEndMs: number;
}

/** Result of parsing a release-style file name (`[Group] Title - 01v2 (1080p) [ABCD1234].mkv`). */
export interface ParsedEpisodeName {
  readonly raw: string;
  /** Cleaned title with group/quality tags removed. */
  readonly title: string;
  readonly episode?: number;
  /** Inclusive range for batch releases (`01-12`). */
  readonly episodeRange?: readonly [number, number];
  readonly season?: number;
  /** `v2` style revision. */
  readonly version?: number;
  readonly releaseGroup?: string;
  /** `1080p`, `720p`, `2160p`, … */
  readonly resolution?: string;
  readonly source?: 'BD' | 'WEB' | 'TV' | 'DVD';
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly crc32?: string;
  readonly isBatch: boolean;
  /** Year found in the name, e.g. `2024`. */
  readonly year?: number;
}

// ---------------------------------------------------------------------------
// 3. Manga
// ---------------------------------------------------------------------------

/** Axis-aligned rectangle in original page pixels (`box = [x1,y1,x2,y2]`). */
export interface MangaRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Same as `MangaRect` but normalised 0..1 relative to the page image. */
export interface MangaRectFraction {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type MangaPoint = readonly [x: number, y: number];

/** Per-character hit cell inside a block (from mokuro `regions` or line subdivision). */
export interface MangaCharRegion {
  readonly rect: MangaRect;
  /** UTF-16 offsets into `MangaBlock.text` (= `lines.join('')`). */
  readonly utf16Start: number;
  readonly utf16End: number;
  /** Rotation around the rect centre in radians (clockwise positive). */
  readonly rotation?: number;
}

export type MangaBlockSource = 'mokuro' | 'vlm' | 'manual';

/**
 * One OCR text block (speech bubble / caption). Mirrors the `.mokuro` v0.2
 * block (`box`, `vertical`, `font_size`, `lines`, `lines_coords`) plus
 * Kotori-side derived fields.
 */
export interface MangaBlock {
  /** Index in `MangaPage.blocks` (stable per volume load). */
  readonly index: number;
  readonly rect: MangaRect;
  readonly vertical: boolean;
  readonly fontSize: number;
  /** Stacking priority; mokuro has none so we use the array index. */
  readonly zIndex: number;
  /** Lines in reading order (vertical text: right→left columns). */
  readonly lines: readonly string[];
  /** `lines.join('')` — the string explanations index into. */
  readonly text: string;
  /** Optional per-line polygons (`lines_coords`): each line is a list of `[x,y]`. */
  readonly linesCoords?: readonly (readonly MangaPoint[])[];
  /** Optional per-character hit cells; derived from `linesCoords` when absent. */
  readonly regions?: readonly MangaCharRegion[];
  readonly source: MangaBlockSource;
  /** OCR confidence 0..1 when the producer reports it. */
  readonly confidence?: number;
}

export interface MangaPage {
  readonly index: number;
  /** Forward-slash relative path inside the volume (e.g. `vol1/p001.jpg`). */
  readonly relativePath: string;
  /** Pixel size reported by the OCR producer (or decoded by the host on import). */
  readonly width: number;
  readonly height: number;
  readonly blocks: readonly MangaBlock[];
  /** URL the `<img>` element can load (desktop `/api/manga/{vol}/page/{i}`; Android file src). */
  readonly imageUrl: string;
}

export type MangaVolumeKind =
  /** `.mokuro` JSON + page images (dir or zip). */
  | 'mokuro'
  /** Plain image folder / CBZ / ZIP with no OCR (VLM on demand). */
  | 'images';

export type MangaReadingMode =
  /** One page at a time, swipe/arrow right→left advances. */
  | 'single-rtl'
  | 'single-ltr'
  /** Two-page spreads, right page first (Japanese default). */
  | 'spread-rtl'
  | 'spread-ltr'
  /** Vertical continuous scroll. */
  | 'webtoon';

export interface MangaReadingProgress {
  readonly pageIndex: number;
  readonly updatedAt: EpochMs;
}

export interface MangaVolume {
  readonly id: Id;
  readonly title: string;
  readonly seriesTitle?: string;
  /** Volume/chapter number when parsable from the name. */
  readonly volumeNumber?: number;
  readonly kind: MangaVolumeKind;
  /** Host-specific path / URI of the source (`.mokuro`, `.cbz`, directory). */
  readonly sourcePath: string;
  readonly pageCount: number;
  readonly hasOcr: boolean;
  readonly coverUrl?: string;
  /** Per-volume override; `undefined` → `AppSettings.manga.defaultReadingMode`. */
  readonly readingMode?: MangaReadingMode;
  /** Cover offset: when true page 0 is shown alone in spread modes. */
  readonly coverIsSingle: boolean;
  readonly addedAt: EpochMs;
  readonly progress?: MangaReadingProgress;
}

/** One side of a two-page spread. */
export type MangaSpreadSlot =
  | { readonly kind: 'page'; readonly pageIndex: number }
  /** Filler when a wide page or the cover sits alone. */
  | { readonly kind: 'blank' };

/**
 * Layout unit produced by `buildSpreads()`. In `spread-rtl`, `right` is read
 * first. Wide pages (`width > height`) always occupy a full spread alone.
 */
export interface MangaSpread {
  readonly index: number;
  readonly left: MangaSpreadSlot;
  readonly right: MangaSpreadSlot;
  /** Page indexes in reading order. */
  readonly pageIndexes: readonly number[];
}

// ---------------------------------------------------------------------------
// 4. Downloads & Acquisition
// ---------------------------------------------------------------------------

export interface NyaaTorrentItem {
  readonly title: string;
  /** `https://nyaa.si/download/<id>.torrent` */
  readonly torrentUrl: string;
  /** Detail page (`guid`). */
  readonly pageUrl: string;
  /** Lower-case hex info hash. */
  readonly infoHash: string;
  /** `magnet:?xt=urn:btih:<infoHash>&dn=…&tr=…` synthesised with Nyaa's default trackers. */
  readonly magnet: string;
  readonly seeders: number;
  readonly leechers: number;
  readonly downloads: number;
  readonly sizeText: string;
  readonly sizeBytes?: number;
  /** Nyaa category id, e.g. `1_4` = Anime – Raw. */
  readonly categoryId: string;
  readonly trusted: boolean;
  readonly remake: boolean;
  readonly publishedAt: EpochMs;
  readonly parsedName: ParsedEpisodeName;
}

export interface NyaaSearchQuery {
  readonly query: string;
  /** Default `1_4` (Anime – Raw) for immersion; `1_0` = all anime. */
  readonly category?: string;
  readonly filter?: 'none' | 'no-remakes' | 'trusted-only';
  readonly sort?: 'seeders' | 'date' | 'size' | 'downloads';
  readonly page?: number;
}

export interface JimakuEntryFlags {
  readonly anime: boolean;
  readonly unverified: boolean;
  readonly external: boolean;
  readonly movie: boolean;
  readonly adult: boolean;
}

export interface JimakuEntry {
  readonly id: number;
  readonly name: string;
  readonly japaneseName?: string;
  readonly englishName?: string;
  readonly anilistId?: number;
  /** `tv:<id>` / `movie:<id>` */
  readonly tmdbId?: string;
  readonly flags: JimakuEntryFlags;
  readonly lastModifiedAt?: EpochMs;
}

export type ArchiveFormat = 'zip' | 'rar' | '7z';

export interface JimakuFile {
  readonly entryId: number;
  readonly name: string;
  readonly url: string;
  readonly sizeBytes?: number;
  readonly lastModifiedAt?: EpochMs;
  /** Lower-case extension without dot. */
  readonly extension: string;
  /** `srt` / `ass` / `vtt` parseable text subtitle. */
  readonly isTextSubtitle: boolean;
  /** Season pack archive (only `zip` can be extracted in-app via fflate). */
  readonly archiveFormat?: ArchiveFormat;
  /** Episode number parsed from the file name. */
  readonly episode?: number;
}

export interface JimakuSearchQuery {
  readonly query?: string;
  readonly anilistId?: number;
  readonly episode?: number;
}

/** One row of a `mokuro.moe` directory listing. */
export interface MokuroCatalogEntry {
  readonly kind: 'dir' | 'file';
  readonly name: string;
  /** Absolute URL (directory URLs end with `/`). */
  readonly url: string;
  readonly sizeText?: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: EpochMs;
  /** `.mokuro` sidecar JSON. */
  readonly isMokuro: boolean;
  /** `.zip` / `.cbz` page-image archive. */
  readonly isImageArchive: boolean;
  /** Optional cover thumbnail URL (resolved from Mokuro Bunko catalog API). */
  readonly coverUrl?: string;
  /** Japanese native title when reported by the catalog API. */
  readonly nativeTitle?: string;
  /** Romaji title when reported by the catalog API. */
  readonly romajiTitle?: string;
  /** English title when reported by the catalog API. */
  readonly englishTitle?: string;
  /** Number of volumes in the series. */
  readonly volumeCount?: number;
  /** Total pages across all volumes in the series. */
  readonly totalPages?: number;
  /** Total OCR character count across all volumes in the series. */
  readonly totalChars?: number;
  /** Community rating score (0–100, e.g. from AniList). */
  readonly score?: number;
  /** Genre labels (e.g. `["Comedy", "Music", "Slice of Life"]`). */
  readonly genres?: readonly string[];
  /** Characteristic tags (e.g. `["4-koma", "Band"]`). */
  readonly tags?: readonly string[];
}

export interface MokuroCatalogListing {
  readonly url: string;
  /** Breadcrumb segments from the catalog root. */
  readonly path: readonly string[];
  readonly entries: readonly MokuroCatalogEntry[];
  /** Pairs of `<name>.mokuro` + `<name>.zip|cbz|dir/` ready to import as one volume. */
  readonly volumes: readonly MokuroCatalogVolume[];
  /** Optional series cover URL when browsing a series. */
  readonly coverUrl?: string;
}

export interface MokuroCatalogVolume {
  readonly name: string;
  readonly mokuroUrl: string;
  /** Archive or directory holding the page images. */
  readonly imagesUrl: string;
  readonly imagesKind: 'archive' | 'dir';
  readonly sizeBytes?: number;
  /** Optional volume cover thumbnail URL. */
  readonly coverUrl?: string;
  /** Optional page count reported by the catalog API. */
  readonly pageCount?: number;
}

export type DownloadKind = 'torrent' | 'jimaku-subtitle' | 'mokuro-volume' | 'http-file';

export type DownloadStatus =
  | 'queued'
  /** Torrent: fetching metadata for a magnet link. */
  | 'resolving'
  | 'downloading'
  | 'paused'
  /** Bytes complete; host is unpacking / registering in the library. */
  | 'importing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TorrentSeriesMetadata {
  readonly anilistId?: number;
  readonly title?: string;
  readonly romajiTitle?: string;
  readonly nativeTitle?: string;
  readonly englishTitle?: string;
  readonly coverUrl?: string;
}

export type DownloadSource =
  | {
      readonly kind: 'torrent';
      readonly infoHash: string;
      readonly magnet?: string;
      readonly torrentUrl?: string;
      /** Optional: only download files matching these indexes once metadata is known. */
      readonly fileIndexes?: readonly number[];
      readonly nyaa?: NyaaTorrentItem;
      /** Optional series identity from Stage-1 discovery for clean library import & automatic subtitle matching. */
      readonly series?: TorrentSeriesMetadata;
    }
  | {
      readonly kind: 'jimaku';
      readonly entry: JimakuEntry;
      readonly file: JimakuFile;
      /** Attach to this episode once downloaded. */
      readonly episodeId?: Id;
      readonly seriesId?: Id;
    }
  | {
      readonly kind: 'mokuro-moe';
      readonly volume: MokuroCatalogVolume;
    }
  | {
      readonly kind: 'http';
      readonly url: string;
      readonly fileName?: string;
    };

export interface DownloadRequest {
  readonly source: DownloadSource;
  /** Display title; defaults derived from the source. */
  readonly title?: string;
  /** Target directory override (host default otherwise). */
  readonly targetDir?: string;
  /** Auto-import into the anime/manga library when finished. */
  readonly autoImport: boolean;
}

export interface DownloadFile {
  readonly index: number;
  readonly path: string;
  readonly sizeBytes: number;
  readonly downloadedBytes: number;
  readonly selected: boolean;
}

export interface DownloadTask {
  readonly id: Id;
  readonly kind: DownloadKind;
  readonly source: DownloadSource;
  readonly title: string;
  readonly status: DownloadStatus;
  /** 0..1 */
  readonly progress: number;
  readonly downloadedBytes: number;
  readonly totalBytes?: number;
  /** Bytes per second (download). */
  readonly speedBps: number;
  readonly uploadSpeedBps?: number;
  readonly peers?: number;
  readonly seeds?: number;
  readonly etaMs?: number;
  readonly files?: readonly DownloadFile[];
  readonly targetDir: string;
  readonly error?: string;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
  readonly completedAt?: EpochMs;
  /** Library object created by auto-import. */
  readonly importedSeriesId?: Id;
  readonly importedVolumeId?: Id;
  readonly importedTrackId?: Id;
}

// ---------------------------------------------------------------------------
// 5. Settings
// ---------------------------------------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark';

export type AppIconId =
  | 's4-01'
  | 's4-02'
  | 's4-03'
  | 's4-04'
  | 's3-01'
  | 's3-02'
  | 's3-03'
  | 's3-04';

export interface UiSettings {
  readonly theme: ThemeMode;
  /** M3 seed colour (hex) for tonal palette generation. */
  readonly seedColor: string;
  /** App chrome locale. */
  readonly locale: 'zh-CN' | 'en' | 'ja';
  /** 0.8..1.6 multiplier for subtitle / bubble text. */
  readonly fontScale: number;
  /** Selected launcher / favicon app icon preset (default `'s4-01'`). */
  readonly appIcon?: AppIconId;
}

export interface AnimeSettings {
  /** Show ASS per-character karaoke merged in the transcript. */
  readonly mergeKaraokeCues: boolean;
  /** Hide typesetting (`\move`, drawings, signs layer) from the transcript. */
  readonly hideSigns: boolean;
  /** Sentence repeat count for the "repeat current line" action (0 = infinite). */
  readonly repeatCount: number;
  /** Pause at end of cue after a jump. */
  readonly pauseAfterJump: boolean;
  /** Pad in ms before/after when seeking to a cue. */
  readonly seekPaddingMs: number;
  readonly autoDownloadJimaku: boolean;
  /** Automatically pre-explain the next 5 upcoming subtitle sentences in 1 batch request while watching. */
  readonly autoPreExplain?: boolean;
  /** jimaku.cc API key (required for its API). */
  readonly jimakuApiKey: string;
  readonly preferredSubtitleLanguages: readonly LanguageTag[];
  /** Furigana display: always (`'all'`, default), never (`'off'`), or on tap (`'tap'`). */
  readonly furiganaMode?: 'all' | 'off' | 'tap';
  /** Show romaji under the Japanese line (default `false`). */
  readonly showRomaji?: boolean;
  /** Collapse the translation until tapped (default `false`, i.e. shown). */
  readonly collapseTranslation?: boolean;
  /** Pause playback when a transcript row is clicked (default `true`). */
  readonly pauseOnTranscriptClick?: boolean;
}

export interface MangaSettings {
  readonly defaultReadingMode: MangaReadingMode;
  /** Draw OCR block outlines on hover/tap. */
  readonly showBlockOutlines: boolean;
  /** Fit mode for page images. */
  readonly fit: 'contain' | 'width' | 'height';
  /** Background behind pages. */
  readonly background: 'black' | 'surface' | 'white';
  /** Preload ±N pages. */
  readonly preloadPages: number;
  /** Automatically pre-explain speech bubbles on the current spread in 1 batch request while reading. */
  readonly autoPreExplain?: boolean;
}

export interface DownloadSettings {
  /** Host default download root. */
  readonly downloadDir: string;
  readonly maxActiveDownloads: number;
  /** Torrent engine limits. */
  readonly maxPeersPerTorrent: number;
  readonly uploadLimitBps?: number;
  readonly downloadLimitBps?: number;
  /** Keep seeding after completion. */
  readonly seedAfterComplete: boolean;
  /** Nyaa mirror base, default `https://nyaa.si`. */
  readonly nyaaBaseUrl: string;
  /** mokuro.moe catalog root, default `https://mokuro.moe/manga/`. */
  readonly mokuroCatalogUrl: string;
}

export interface LibrarySettings {
  /** Folders scanned for anime (desktop) or tree URIs (Android). */
  readonly animeRoots: readonly string[];
  readonly mangaRoots: readonly string[];
}

export interface AppSettings {
  readonly schemaVersion: 1;
  readonly ai: AiSettings;
  readonly ui: UiSettings;
  readonly anime: AnimeSettings;
  readonly manga: MangaSettings;
  readonly downloads: DownloadSettings;
  readonly library: LibrarySettings;
}

/** Deep-partial patch applied by `settings.update()`. */
export type SettingsPatch = {
  readonly [K in keyof AppSettings]?: K extends 'schemaVersion' ? never : DeepPartial<AppSettings[K]>;
};

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly U[]
  : T extends object
    ? { readonly [P in keyof T]?: DeepPartial<T[P]> }
    : T;

// ---------------------------------------------------------------------------
// 6. Errors & Events
// ---------------------------------------------------------------------------

export type KotoriErrorCode =
  | 'not-found'
  | 'invalid-argument'
  | 'unsupported'
  | 'io'
  | 'network'
  | 'parse'
  | 'ai-auth'
  | 'ai-quota'
  | 'ai-safety'
  | 'ai-invalid-response'
  | 'ai-timeout'
  | 'cancelled'
  | 'internal';

/** Serialisable error crossing the host boundary (REST / Capacitor bridge). */
export interface KotoriErrorShape {
  readonly code: KotoriErrorCode;
  readonly message: string;
  /** Machine-readable extra context (HTTP status, provider error id, …). */
  readonly details?: Readonly<Record<string, unknown>>;
}

export type HostEvent =
  | { readonly type: 'download-updated'; readonly task: DownloadTask }
  | { readonly type: 'download-removed'; readonly taskId: Id }
  | { readonly type: 'library-changed'; readonly scope: 'anime' | 'manga' }
  | { readonly type: 'settings-changed'; readonly settings: AppSettings }
  | { readonly type: 'host-notice'; readonly level: 'info' | 'warning' | 'error'; readonly message: string }
  | {
      readonly type: 'dict-import-progress';
      readonly dictId: Id;
      readonly title: string;
      readonly phase: 'downloading' | 'importing' | 'ready' | 'failed';
      readonly processedRows: number;
      readonly error?: string;
    };

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// 6b. Dictionaries (local Yomitan v3 engine; enrichment is render-time only)
// ---------------------------------------------------------------------------

/** What an imported dictionary contributes: glosses, pitch, frequency, or several. */
export type DictionaryKind = 'term' | 'pitch' | 'freq' | 'mixed';

/** `importing` rows are invisible to lookups and purged on startup. */
export type DictionaryStatus = 'importing' | 'ready';

export interface DictionaryInfo {
  readonly id: Id;
  readonly title: string;
  readonly revision: string;
  readonly kind: DictionaryKind;
  readonly status: DictionaryStatus;
  /** Lower value = shown first. */
  readonly priority: number;
  readonly enabled: boolean;
  readonly termCount: number;
  readonly metaCount: number;
  readonly attribution?: string;
  readonly sourceUrl?: string;
  /** Standalone `index.json` endpoint used to check for updates. */
  readonly indexUrl?: string;
  readonly importedAt: EpochMs;
}

/** One compact dictionary sense (gloss + at most a few example pairs). */
export interface CompactSense {
  readonly gloss: string;
  /** `[japanese, translation]` example pairs. */
  readonly examples?: ReadonlyArray<readonly [string, string]>;
  readonly tags?: readonly string[];
}

/** One `term_bank` row after import-time compaction. */
export interface CompactTermRecord {
  readonly dictId: Id;
  /** Row ordinal inside the dictionary (0..N-1). */
  readonly seq: number;
  readonly expression: string;
  /** Hiragana; `''` when the source had no reading and the expression is not kana. */
  readonly reading: string;
  readonly defTags: string;
  readonly rules: string;
  readonly score: number;
  /** JMdict-style sequence number (0 when absent). */
  readonly sequenceId: number;
  /** Set when the row is a pure `[[formOf, [rules]]]` / `non-lemma` redirect. */
  readonly redirectTo?: string;
  readonly senses: readonly CompactSense[];
  /** Lookup keys: `[expression]` or `[expression, reading]`. */
  readonly keys: readonly string[];
}

export interface PitchPattern {
  /** Downstep position (0 = 平板). */
  readonly position: number;
  readonly nasal?: readonly number[];
  readonly devoice?: readonly number[];
}

/** Pitch rows merged across dictionaries only when the full payload is identical. */
export interface MergedPitchGroup {
  readonly reading: string;
  readonly position: number;
  readonly nasal?: readonly number[];
  readonly devoice?: readonly number[];
  /** Titles of every dictionary that reported this exact payload. */
  readonly sources: readonly string[];
}

export interface FrequencyBadge {
  readonly dictId: Id;
  readonly dictTitle: string;
  readonly value: number;
  readonly displayValue: string;
  /** Kana-orthography frequency (JPDB `㋕`). */
  readonly kanaOnly?: boolean;
}

export interface DictionarySenseGroup {
  readonly dictId: Id;
  readonly dictTitle: string;
  readonly expression: string;
  readonly reading: string;
  readonly defTags: string;
  readonly senses: readonly CompactSense[];
  /** Index into `senses` best matching the AI contextual meaning. */
  readonly matchedSenseIdx?: number;
}

/** One homograph candidate shown in the `uncertain` state. */
export interface VocabCandidate {
  readonly expression: string;
  readonly reading: string;
  readonly pitches: readonly MergedPitchGroup[];
  readonly frequencies: readonly FrequencyBadge[];
  readonly senseGroups: readonly DictionarySenseGroup[];
}

/** Render-time dictionary enrichment of one `VocabEntry` (never cached in explanations). */
export interface VocabEnrichment {
  readonly status: 'matched' | 'uncertain' | 'empty';
  readonly headword?: string;
  readonly reading?: string;
  readonly pitches: readonly MergedPitchGroup[];
  readonly frequencies: readonly FrequencyBadge[];
  readonly senseGroups: readonly DictionarySenseGroup[];
  readonly candidates?: readonly VocabCandidate[];
}

export interface RecommendedDictPreset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly kind: DictionaryKind;
  readonly sizeLabel: string;
  readonly license: string;
  readonly attribution: string;
  readonly downloadUrl: string;
  readonly indexUrl?: string;
  readonly isUpdatable: boolean;
  /** Not redistributable: the UI links out instead of one-click installing. */
  readonly externalOnly?: boolean;
}

/** One longest-prefix match for click-to-lookup (P2). */
export interface InstantLookupMatch {
  readonly surface: string;
  readonly matchedLength: number;
  readonly lemma: string;
  readonly reading: string;
  /** Deinflection reasons applied, surface → lemma order. */
  readonly deinflectChain: readonly string[];
  readonly pitches: readonly MergedPitchGroup[];
  readonly frequencies: readonly FrequencyBadge[];
  readonly senseGroups: readonly DictionarySenseGroup[];
}

export interface DictionaryImportSource {
  readonly filePath?: string;
  readonly url?: string;
  readonly presetId?: string;
  readonly bytes?: Uint8Array;
  readonly fileName?: string;
  readonly attribution?: string;
  readonly indexUrl?: string;
}

export interface DictionaryHost {
  list(): Promise<DictionaryInfo[]>;
  importZip(source: DictionaryImportSource): Promise<DictionaryInfo>;
  update(id: Id, patch: { enabled?: boolean; priority?: number }): Promise<DictionaryInfo>;
  remove(id: Id): Promise<void>;
  /** Keyed by `VocabEntry.id`. */
  enrichVocab(vocab: readonly VocabEntry[]): Promise<Record<string, VocabEnrichment>>;
  lookupPrefix(text: string, maxLength?: number): Promise<InstantLookupMatch[]>;
}

// ---------------------------------------------------------------------------
// 7. PlatformHost contract
// ---------------------------------------------------------------------------

/**
 * Feature flags the UI consults to show/hide affordances. A host MUST set a
 * flag to `false` rather than throw `unsupported` for whole features.
 */
export interface HostCapabilities {
  /** Built-in BitTorrent engine (desktop: yes; Android: no → hand off magnet to external app). */
  readonly torrent: boolean;
  /** MKV embedded subtitle extraction via system ffmpeg. */
  readonly embeddedSubtitles: boolean;
  /** Vertex AI **ADC** auth available in this host (desktop only). `access-token`, `service-account-json` and `express-api-key` work on every host. */
  readonly vertexAdc: boolean;
  /** Host can present a native directory picker (`files.pickDirectory`). */
  readonly directoryPicker: boolean;
  /** Host can present a native file picker (`files.pickFiles`). */
  readonly filePicker: boolean;
  /** Host can browse arbitrary server-side paths (`files.listDirectory`). */
  readonly pathBrowser: boolean;
  /** Streaming follow-up answers (`ai.followUpStream`). */
  readonly streaming: boolean;
  /** Host can open a URL/magnet in an external application. */
  readonly openExternal: boolean;
}

export interface HostInfo {
  readonly platform: 'node' | 'android' | 'mock';
  readonly os: 'macos' | 'linux' | 'windows' | 'android' | 'unknown';
  readonly version: string;
  readonly capabilities: HostCapabilities;
  /** Absolute data directory (desktop) or app sandbox (Android). */
  readonly dataDir: string;
}

export interface SettingsApi {
  get(): Promise<AppSettings>;
  update(patch: SettingsPatch): Promise<AppSettings>;
  /** Round-trip a tiny prompt through the configured provider. */
  testAi(settings?: AiSettings): Promise<AiConnectionTestResult>;
}

export interface AnimeImportRequest {
  /** Directory (desktop path / Android tree URI) or single video file. */
  readonly path: string;
  readonly titleOverride?: string;
  readonly anilistId?: number;
  readonly coverUrl?: string;
}

export interface AnimeSeriesUpdatePatch {
  readonly title?: string;
  /** Pass `null` to unlink AniList metadata. */
  readonly anilistId?: number | null;
  /** Pass `null` to clear cover URL / auto-fetched poster. */
  readonly coverUrl?: string | null;
}

export interface AnimeApi {
  listSeries(): Promise<readonly AnimeSeries[]>;
  getSeries(seriesId: Id): Promise<AnimeSeries>;
  listEpisodes(seriesId: Id): Promise<readonly AnimeEpisode[]>;
  getEpisode(episodeId: Id): Promise<AnimeEpisode>;
  importSeries(request: AnimeImportRequest): Promise<AnimeSeries>;
  updateSeries(seriesId: Id, patch: AnimeSeriesUpdatePatch): Promise<AnimeSeries>;
  removeSeries(seriesId: Id, deleteFiles?: boolean): Promise<void>;
  /** Re-scan the series folder for new episodes / sidecar subtitles. */
  rescanSeries(seriesId: Id): Promise<AnimeSeries>;
  /** Parsed, delay-adjusted cues for a track (host caches parse results). */
  getCues(trackId: Id): Promise<ParsedSubtitleTrack>;
  /** Attach a subtitle file (path/URI) or raw content to an episode. */
  addSubtitleTrack(episodeId: Id, input: { readonly path?: string; readonly content?: string; readonly fileName: string; readonly language?: LanguageTag }): Promise<SubtitleTrack>;
  /** Extract an MKV embedded text stream to a file-backed track (requires `embeddedSubtitles`). */
  extractEmbeddedTrack(episodeId: Id, streamIndex: number): Promise<SubtitleTrack>;
  removeSubtitleTrack(trackId: Id): Promise<void>;
  setTrackDelay(trackId: Id, delayMs: number): Promise<SubtitleTrack>;
  setDefaultTrack(episodeId: Id, trackId: Id): Promise<void>;
  saveProgress(episodeId: Id, progress: PlaybackProgress): Promise<void>;
  /** Search Jimaku for this series and download the best matching file for each episode. */
  autoFetchJimaku(seriesId: Id, options?: { readonly entryId?: number }): Promise<readonly DownloadTask[]>;
}

export interface MangaImportRequest {
  /** `.mokuro` file, `.cbz`/`.zip`, or an image directory. */
  readonly path: string;
  readonly titleOverride?: string;
}

export interface MangaApi {
  listVolumes(): Promise<readonly MangaVolume[]>;
  getVolume(volumeId: Id): Promise<MangaVolume>;
  importVolume(request: MangaImportRequest): Promise<MangaVolume>;
  removeVolume(volumeId: Id, deleteFiles?: boolean): Promise<void>;
  /** Page metadata + OCR blocks (images are loaded via `MangaPage.imageUrl`). */
  getPage(volumeId: Id, pageIndex: number): Promise<MangaPage>;
  /** All pages' metadata in one call (for spread layout / webtoon virtualisation). */
  getPages(volumeId: Id): Promise<readonly MangaPage[]>;
  setReadingMode(volumeId: Id, mode: MangaReadingMode | undefined): Promise<MangaVolume>;
  setCoverIsSingle(volumeId: Id, single: boolean): Promise<MangaVolume>;
  saveProgress(volumeId: Id, progress: MangaReadingProgress): Promise<void>;
  /** Persist VLM-recognised blocks onto a raw-image page so they survive reloads. */
  addBlocks(volumeId: Id, pageIndex: number, blocks: readonly Omit<MangaBlock, 'index'>[]): Promise<MangaPage>;
}

/** Per-call options for long-running AI methods. */
export interface AiCallOptions {
  /**
   * Abort the in-flight model call (e.g. the user clicked another sentence).
   * Implementations reject with `KotoriError('cancelled')`.
   */
  readonly signal?: AbortSignal;
}

export interface AiApi {
  explain(request: ExplainRequest, options?: AiCallOptions): Promise<SentenceExplanation>;
  /** Batch-explain up to N sentences in a single model request and populate the explanation cache. */
  explainBatch?(requests: readonly ExplainRequest[], options?: AiCallOptions): Promise<readonly SentenceExplanation[]>;
  /** Cached explanation lookup without a model call (`undefined` on miss). */
  getCachedExplanation(request: ExplainRequest): Promise<SentenceExplanation | undefined>;
  followUp(request: FollowUpRequest, options?: AiCallOptions): Promise<FollowUpMessage>;
  /** Streaming variant; hosts without `capabilities.streaming` may omit it. */
  followUpStream?(request: FollowUpRequest, onDelta: (delta: FollowUpDelta) => void, options?: AiCallOptions): Promise<FollowUpMessage>;
  ocrBubble(request: MangaBubbleOcrRequest, options?: AiCallOptions): Promise<MangaBubbleOcrResult>;
  pageGuide(request: MangaPageGuideRequest, options?: AiCallOptions): Promise<MangaPageGuideResult>;
  /** Persisted follow-up threads per explanation. */
  getThread(explanationId: Id): Promise<readonly FollowUpMessage[]>;
  clearCache(): Promise<{ readonly removed: number }>;
}

export interface DownloadsApi {
  searchNyaa(query: NyaaSearchQuery): Promise<readonly NyaaTorrentItem[]>;
  searchJimaku(query: JimakuSearchQuery): Promise<readonly JimakuEntry[]>;
  listJimakuFiles(entryId: number, episode?: number): Promise<readonly JimakuFile[]>;
  browseMokuroCatalog(url?: string): Promise<MokuroCatalogListing>;
  list(): Promise<readonly DownloadTask[]>;
  get(taskId: Id): Promise<DownloadTask>;
  start(request: DownloadRequest): Promise<DownloadTask>;
  pause(taskId: Id): Promise<DownloadTask>;
  resume(taskId: Id): Promise<DownloadTask>;
  cancel(taskId: Id): Promise<DownloadTask>;
  /** Remove from list; optionally delete downloaded files. */
  remove(taskId: Id, deleteFiles?: boolean): Promise<void>;
  /** Select which files of a torrent to fetch (after metadata is resolved). */
  selectFiles(taskId: Id, fileIndexes: readonly number[]): Promise<DownloadTask>;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'dir' | 'file';
  readonly sizeBytes?: number;
}

export interface FilesApi {
  /** Native directory picker; `undefined` when cancelled. */
  pickDirectory?(): Promise<string | undefined>;
  /** Native file picker; empty array when cancelled. */
  pickFiles?(options?: { readonly accept?: readonly string[]; readonly multiple?: boolean }): Promise<readonly string[]>;
  /** Server-side path browser (desktop); `path` undefined ⇒ roots/home. */
  listDirectory?(path?: string): Promise<{ readonly path: string; readonly parent?: string; readonly entries: readonly DirectoryEntry[] }>;
  /** Open URL / magnet / file in the OS default handler. */
  openExternal?(url: string): Promise<void>;
}

export type ScreenOrientationMode = 'landscape' | 'portrait-then-unlock' | 'keep';

export interface ScreenImmersiveOptions {
  immersive: boolean;
  orientation?: ScreenOrientationMode;
}

export interface ScreenApi {
  /** Hide/show system bars; optionally lock/unlock screen orientation. Idempotent. */
  setImmersive(opts: ScreenImmersiveOptions): Promise<void>;
}

/**
 * The one abstraction between the shared UI and the platform. Implemented by:
 * - `@kotori/host-node/client` → `RestPlatformHost` (browser → local HTTP server)
 * - `@kotori/host-android`     → `CapacitorPlatformHost` (WebView, in-process)
 * - `@kotori/ui/dev`           → `MockPlatformHost` (fixtures for UI dev/tests)
 *
 * All methods reject with a `KotoriErrorShape`-compatible `Error` (`code`
 * property). Methods never return `null`; absence is `undefined` or `not-found`.
 */
export interface PlatformHost {
  readonly info: HostInfo;
  readonly settings: SettingsApi;
  readonly anime: AnimeApi;
  readonly manga: MangaApi;
  readonly ai: AiApi;
  readonly downloads: DownloadsApi;
  readonly files: FilesApi;
  /** Local dictionaries (optional until every host wires it; absent ⇒ zero-dict fallback). */
  readonly dict?: DictionaryHost;
  readonly screen?: ScreenApi;
  /** Push events (download progress, library changes). */
  subscribe(listener: (event: HostEvent) => void): Unsubscribe;
  /** Release sockets / event sources. */
  dispose(): Promise<void>;
}
