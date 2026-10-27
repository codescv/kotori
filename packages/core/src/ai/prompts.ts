/**
 * Prompt builders. Bumping `PROMPT_VERSION` changes every explanation cache
 * key, so prompt upgrades invalidate stale explanations naturally.
 */
import type { AiPersonaSettings, ExplainRequest, FollowUpMessage, MangaBubbleOcrRequest, MangaPageGuideRequest, SentenceExplanation, TargetLanguage } from '../types';
import type { GeminiContent } from './gemini-client';

export const PROMPT_VERSION = 'v1';

/** System instruction + conversation, ready for `GeminiRequest`. */
export interface PromptParts {
  readonly systemInstruction: string;
  readonly contents: readonly GeminiContent[];
}

const LANGUAGE_NAMES: Record<TargetLanguage, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
};

/** Human-readable name for a target language (used inside prompts). */
export function targetLanguageName(lang: TargetLanguage = 'zh-CN'): string {
  return LANGUAGE_NAMES[lang] ?? lang;
}

/** System instruction for the sentence breakdown. */
export function explainSystemInstruction(lang: TargetLanguage): string {
  const out = targetLanguageName(lang);
  return [
    'You are an expert Japanese teacher who explains real, spoken Japanese from anime and manga to learners.',
    'Break the TARGET sentence down and answer ONLY with JSON matching the response schema.',
    '',
    'Rules:',
    '1. `chunks` are semantic chunks (意群/phrases) that cover the TARGET sentence from left to right, in order, without gaps or overlaps (punctuation may be left out).',
    '2. Every `surface` (chunk and vocab) MUST be a verbatim substring of the TARGET sentence, copied character-for-character (same kana/kanji, same width, same small kana, same long-vowel marks). Never normalise, never correct typos, never output indices.',
    '3. Each vocab `surface` lies inside its chunk\'s `surface`; list vocab in left-to-right order. `lemma` is the dictionary form.',
    '4. `ruby` segments the WHOLE TARGET sentence: concatenating every `base` must reproduce the sentence exactly. Give `ruby` (hiragana reading) ONLY on segments containing kanji; omit it for kana, Latin, digits and punctuation. Prefer short kanji-run segments (e.g. 食|べて, not 食べて).',
    '5. `textbookForm` is always present: the standard/textbook form of the chunk (e.g. surface てんじゃねぇ → textbookForm ているのではない). If the chunk is already standard, repeat the surface.',
    '6. `spokenEvolution` ONLY when surface differs from textbookForm: `kind` (short label such as 縮約, 音便, 俗语, 方言), `derivation` as steps "A → B → C", `formality` from 0 (very rough) to 1 (formal). Omit it otherwise.',
    `7. Write every explanation field (translation, literalTranslation, tone, culturalNote, role, meaning, nuance, derivation, conjugation, notes, grammar explanation) in ${out}.`,
    '8. Context lines are for understanding only. Explain ONLY the TARGET sentence.',
    '9. `grammar.chunkSurfaces` lists the chunk surfaces (verbatim) that instantiate each pattern; write `pattern` in textbook notation such as 〜ばかりに.',
    '10. Add `literalTranslation` only when it differs meaningfully from `translation`.',
    '11. Keep explanations concise and crisp. Only include content-bearing words or special expressions in `vocab` (skip trivial single-character case particles like の/を/に/が/は unless used in a special idiom).',
    '12. Populate `culturalNote` (1-2 sentences) ONLY when the sentence contains a notable Japanese cultural reference, ACG/band/manga trope, wordplay/pun, dialectal quirk, or pragmatic irony; omit `culturalNote` for ordinary literal sentences.',
  ].join('\n');
}

/**
 * Build the explain prompt for `req`. Context lines are clearly separated
 * from the TARGET sentence, which is quoted verbatim.
 */
export function buildExplainPrompt(req: ExplainRequest): PromptParts {
  const lines: string[] = [];
  if (req.sceneHint) lines.push(`Scene: ${req.sceneHint}`);
  if (req.contextBefore && req.contextBefore.length > 0) lines.push('Context before (do not explain):', ...req.contextBefore.map((l) => `- ${l}`));
  if (req.contextAfter && req.contextAfter.length > 0) lines.push('Context after (do not explain):', ...req.contextAfter.map((l) => `- ${l}`));
  if (req.focusCharIndex !== undefined && req.focusCharIndex >= 0 && req.focusCharIndex < req.sentence.length) {
    const ch = req.sentence.slice(req.focusCharIndex, req.focusCharIndex + 1);
    lines.push(`The learner clicked the character 「${ch}」 (pay extra attention to the chunk containing it, but still explain the whole sentence).`);
  }
  lines.push('TARGET sentence (between the markers, verbatim):', '<<<', req.sentence, '>>>');
  return { systemInstruction: explainSystemInstruction(req.targetLanguage), contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }] };
}

/**
 * Build a single batch prompt that breaks down N target sentences in order in
 * one LLM call. Surrounding sentences in the batch naturally act as dialogue
 * context for each other.
 */
export function buildBatchExplainPrompt(requests: readonly ExplainRequest[]): PromptParts {
  const first = requests[0];
  const lang = first?.targetLanguage ?? 'zh-CN';
  const systemInstruction = [
    explainSystemInstruction(lang),
    '',
    'BATCH MODE:',
    'You are given N numbered TARGET sentences in order (#1 .. #N).',
    'Return `items` with exactly N breakdown objects in the exact same order (#1 .. #N).',
    'Each item i must break down ONLY TARGET sentence #(i+1) verbatim (its `ruby` and `chunks` surfaces must match sentence #(i+1) character-for-character).',
    'Use the surrounding sentences in the batch and any provided context lines as natural dialogue context.',
  ].join('\n');

  const lines: string[] = [];
  if (first?.sceneHint) lines.push(`Scene: ${first.sceneHint}`);
  if (first?.contextBefore && first.contextBefore.length > 0) {
    lines.push('Context before #1 (do not explain):', ...first.contextBefore.map((l) => `- ${l}`));
  }
  const last = requests[requests.length - 1];
  if (last?.contextAfter && last.contextAfter.length > 0) {
    lines.push(`Context after #${requests.length} (do not explain):`, ...last.contextAfter.map((l) => `- ${l}`));
  }
  lines.push(`Break down each of the following ${requests.length} TARGET sentences in order:`);
  requests.forEach((req, idx) => {
    lines.push(`#${idx + 1}: <<<${req.sentence}>>>`);
  });

  return { systemInstruction, contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }] };
}

/** Nudge appended after an invalid JSON answer (one retry). */
export const INVALID_JSON_NUDGE =
  'Your previous answer was not valid JSON for the required schema. Return ONLY one valid JSON object matching the schema, with no prose and no code fences.';

/** Compact text summary of an explanation used as follow-up context. */
export function summariseExplanation(expl: SentenceExplanation): string {
  const summary = {
    sentence: expl.sentence,
    translation: expl.translation,
    literalTranslation: expl.literalTranslation,
    register: expl.register,
    tone: expl.tone,
    culturalNote: expl.culturalNote,
    chunks: expl.chunks.map((c) => ({
      surface: c.surface,
      reading: c.reading,
      textbookForm: c.textbookForm,
      spokenEvolution: c.spokenEvolution,
      role: c.role,
      meaning: c.meaning,
      nuance: c.nuance,
    })),
    vocab: expl.vocab.map((v) => ({ surface: v.surface, lemma: v.lemma, reading: v.lemmaReading, pos: v.partOfSpeech, meaning: v.meaning, conjugation: v.conjugation })),
    grammar: expl.grammar.map((g) => ({ pattern: g.pattern, explanation: g.explanation })),
  };
  return JSON.stringify(summary);
}

/**
 * Build a follow-up conversation: explanation JSON summary as context, then
 * the prior thread (oldest first), then the new question.
 */
export function buildFollowUpPrompt(
  expl: SentenceExplanation,
  history: readonly FollowUpMessage[] = [],
  question: string,
  targetLanguage: TargetLanguage = expl.targetLanguage ?? 'zh-CN',
  persona?: AiPersonaSettings,
): PromptParts {
  const name = persona?.name?.trim();
  const soul = persona?.soul?.trim();
  const systemInstruction = [
    'You are a friendly, precise Japanese teacher answering follow-up questions about one sentence a learner is studying.',
    ...(name ? [`Your name/nickname is "${name}".`] : []),
    ...(soul ? [`Your persona / soul (stay in character while keeping Japanese grammatical and lexical explanations accurate):\n${soul}`] : []),
    `Answer in ${targetLanguageName(targetLanguage)}. Be concise. Markdown-light only: **bold**, lists and \`inline code\`; no HTML, no headings, no tables.`,
    'Quote Japanese verbatim. If the question is unrelated to Japanese learning, answer briefly and steer back.',
    '',
    'Breakdown of the sentence being discussed (JSON):',
    summariseExplanation(expl),
  ].join('\n');
  const contents: GeminiContent[] = history
    .filter((m) => m.text.trim() !== '')
    .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  contents.push({ role: 'user', parts: [{ text: question }] });
  return { systemInstruction, contents };
}

/** Prompt for OCR of a cropped manga speech bubble. */
export function buildBubbleOcrPrompt(req: MangaBubbleOcrRequest): PromptParts {
  const systemInstruction = [
    'You are a meticulous OCR engine for Japanese manga.',
    'Transcribe ALL Japanese text in the image exactly as printed (keep kana/kanji, small kana, long-vowel marks, ！？…). Do not translate, do not add furigana that is printed small beside kanji (ignore ruby text).',
    'Return `lines` in reading order: for vertical text, columns from right to left, each column top to bottom; for horizontal text, rows top to bottom.',
    'Set `vertical` to true when the text is written vertically. `confidence` is your 0..1 confidence.',
    'If there is no text, return an empty `lines` array.',
  ].join('\n');
  return {
    systemInstruction,
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: req.image.mimeType, data: req.image.base64 } }, { text: 'Transcribe the Japanese text in this speech bubble.' }],
      },
    ],
  };
}

/** Prompt for a whole-page reading guide. */
export function buildPageGuidePrompt(req: MangaPageGuideRequest): PromptParts {
  const out = targetLanguageName(req.targetLanguage);
  const systemInstruction = [
    'You are a Japanese manga reading guide for language learners.',
    'Find every speech bubble / caption with Japanese text on the page and list them in Japanese reading order (right-to-left, top-to-bottom), `order` starting at 1.',
    '`box` is the bubble bounding box normalised to 0..1000 relative to the image (left, top, right, bottom).',
    '`text` is the verbatim Japanese text; `translation`, `note` (short grammar/slang/culture note, optional) and `summary` (one-paragraph scene summary) are written in ' + out + '.',
    '`speaker` is optional (character name or description).',
    'When known OCR blocks are provided, set `blockIndex` to the matching block index and reuse its text verbatim.',
  ].join('\n');
  const parts: GeminiContent['parts'][number][] = [{ inlineData: { mimeType: req.image.mimeType, data: req.image.base64 } }];
  const known = req.knownBlocks ?? [];
  if (known.length > 0) {
    const w = req.image.width || 1;
    const h = req.image.height || 1;
    const listing = known.map((b) => `#${b.index}: ${b.text}`).join('\n');
    parts.push({ text: `Known OCR blocks (index: text). Page image size ${w}x${h}.\n${listing}` });
  }
  parts.push({ text: 'Create the reading guide for this page.' });
  return { systemInstruction, contents: [{ role: 'user', parts }] };
}
