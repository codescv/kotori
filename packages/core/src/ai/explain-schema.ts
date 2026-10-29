/**
 * Raw model-output schemas: zod validators (tolerant of nulls / unknown enum
 * values) plus the matching Gemini `responseSchema` JSON (OpenAPI subset).
 *
 * The model returns `surface` strings and readings — **never indices**;
 * `alignSpans` maps them back onto the sentence.
 */
import { z } from 'zod';
import type { PartOfSpeech } from '../types';

export const PARTS_OF_SPEECH = [
  'noun',
  'verb',
  'i-adjective',
  'na-adjective',
  'adverb',
  'particle',
  'auxiliary',
  'conjunction',
  'pronoun',
  'counter',
  'interjection',
  'expression',
  'prefix',
  'suffix',
  'proper-noun',
  'onomatopoeia',
  'other',
] as const satisfies readonly PartOfSpeech[];

export const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'] as const;
export const REGISTERS = ['polite', 'plain', 'casual', 'rough', 'honorific', 'humble', 'dialect', 'literary'] as const;

/** `null` → `undefined` so optional fields accept JSON nulls. */
const nullish = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null ? undefined : v), schema.optional());

/** Optional string that also maps `''` → `undefined`. */
const optString = nullish(z.string()).transform((s) => (s === undefined || s.trim() === '' ? undefined : s));
/** Required string, defaulting to `''`. */
const reqString = z.preprocess((v) => (v === null || v === undefined ? '' : v), z.string());
/** Optional JLPT level; unknown values are dropped. */
const optJlpt = z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase().trim() : undefined), z.enum(JLPT_LEVELS).optional().catch(undefined));
/** Optional finite number (accepts numeric strings). */
const optNumber = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v === null ? undefined : v),
  z.number().finite().optional().catch(undefined),
);
/** Array defaulting to `[]` when missing / null. */
const arrayOf = <T extends z.ZodType>(item: T) => z.preprocess((v) => (v === null || v === undefined ? [] : v), z.array(item));

export const RawRubySchema = z.object({
  base: reqString,
  ruby: optString,
});

export const RawSpokenEvolutionSchema = z.object({
  kind: reqString,
  derivation: reqString,
  formality: optNumber,
});

export const RawVocabSchema = z.object({
  surface: reqString,
  lemma: reqString,
  lemmaReading: reqString,
  /** Legacy (≤ v2 prompts / old caches): no longer requested; computed locally via `computeLemmaRuby` when absent. */
  lemmaRuby: nullish(z.array(RawRubySchema)).catch(undefined),
  partOfSpeech: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase().trim().replace(/[\s_]+/g, '-') : v), z.enum(PARTS_OF_SPEECH).catch('other')),
  meaning: reqString,
  conjugation: optString,
  /** Legacy: no longer in the response schema (replaced by dictionary frequency); still accepted. */
  jlpt: optJlpt,
  /** Legacy: no longer in the response schema; still accepted if a model sends it. */
  pitchAccent: optNumber,
  notes: optString,
});

export const RawChunkSchema = z.object({
  surface: reqString,
  reading: reqString,
  textbookForm: reqString,
  spokenEvolution: nullish(RawSpokenEvolutionSchema).catch(undefined),
  grammarPattern: optString,
  role: reqString,
  meaning: reqString,
  nuance: optString,
  vocab: arrayOf(RawVocabSchema),
});

export const RawOmittedSchema = z.object({
  text: reqString,
  role: optString,
});

export const RawGrammarSchema = z.object({
  pattern: reqString,
  chunkSurfaces: arrayOf(z.string()),
  explanation: reqString,
  jlpt: optJlpt,
});

/** Validator for the explain model output. */
export const RawExplanationSchema = z.object({
  translation: z.string(),
  literalTranslation: optString,
  register: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase().trim() : undefined), z.enum(REGISTERS).optional().catch(undefined)),
  tone: optString,
  culturalNote: optString,
  omitted: arrayOf(RawOmittedSchema).catch([]),
  dialogueRelation: optString,
  ruby: arrayOf(RawRubySchema),
  chunks: arrayOf(RawChunkSchema),
  grammar: arrayOf(RawGrammarSchema).optional().default([]).catch([]),
});

export type RawRuby = z.infer<typeof RawRubySchema>;
export type RawVocab = z.infer<typeof RawVocabSchema>;
export type RawChunk = z.infer<typeof RawChunkSchema>;
export type RawOmitted = z.infer<typeof RawOmittedSchema>;
export type RawGrammar = z.infer<typeof RawGrammarSchema>;
export type RawExplanation = z.infer<typeof RawExplanationSchema>;

// --- Gemini responseSchema (OpenAPI subset) ---------------------------------

const S = { type: 'STRING' } as const;
const RUBY_ITEMS = { type: 'ARRAY', items: { type: 'OBJECT', properties: { base: S, ruby: S }, required: ['base'], propertyOrdering: ['base', 'ruby'] } } as const;

/** Gemini JSON schema mirroring `RawExplanationSchema`. */
export const EXPLAIN_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    translation: S,
    literalTranslation: S,
    register: { type: 'STRING', enum: [...REGISTERS] },
    tone: S,
    culturalNote: S,
    omitted: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { text: S, role: S }, required: ['text'], propertyOrdering: ['text', 'role'] },
    },
    dialogueRelation: S,
    ruby: RUBY_ITEMS,
    chunks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          surface: S,
          reading: S,
          textbookForm: S,
          spokenEvolution: {
            type: 'OBJECT',
            properties: { kind: S, derivation: S, formality: { type: 'NUMBER' } },
            required: ['kind', 'derivation'],
            propertyOrdering: ['kind', 'derivation', 'formality'],
          },
          grammarPattern: S,
          role: S,
          meaning: S,
          nuance: S,
          vocab: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                surface: S,
                lemma: S,
                lemmaReading: S,
                partOfSpeech: { type: 'STRING', enum: [...PARTS_OF_SPEECH] },
                meaning: S,
                conjugation: S,
                notes: S,
              },
              required: ['surface', 'lemma', 'lemmaReading', 'partOfSpeech', 'meaning'],
              propertyOrdering: ['surface', 'lemma', 'lemmaReading', 'partOfSpeech', 'meaning', 'conjugation', 'notes'],
            },
          },
        },
        required: ['surface', 'reading', 'textbookForm', 'role', 'meaning', 'vocab'],
        propertyOrdering: ['surface', 'reading', 'textbookForm', 'spokenEvolution', 'grammarPattern', 'role', 'meaning', 'nuance', 'vocab'],
      },
    },
  },
  required: ['translation', 'ruby', 'chunks'],
  propertyOrdering: ['translation', 'literalTranslation', 'register', 'tone', 'culturalNote', 'omitted', 'dialogueRelation', 'ruby', 'chunks'],
} as const;

export const RawBatchExplanationSchema = z.object({
  items: arrayOf(RawExplanationSchema),
});
export type RawBatchExplanation = z.infer<typeof RawBatchExplanationSchema>;

/** Gemini JSON schema for explaining N sentences in a single batch call. */
export const BATCH_EXPLAIN_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: EXPLAIN_RESPONSE_SCHEMA,
    },
  },
  required: ['items'],
  propertyOrdering: ['items'],
} as const;

// --- Vision (manga) ---------------------------------------------------------

export const RawBubbleOcrSchema = z.object({
  lines: arrayOf(z.string()),
  vertical: z.preprocess((v) => (v === null || v === undefined ? true : v), z.boolean()).catch(true),
  confidence: optNumber,
});
export type RawBubbleOcr = z.infer<typeof RawBubbleOcrSchema>;

export const BUBBLE_OCR_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: { lines: { type: 'ARRAY', items: S }, vertical: { type: 'BOOLEAN' }, confidence: { type: 'NUMBER' } },
  required: ['lines', 'vertical'],
  propertyOrdering: ['lines', 'vertical', 'confidence'],
} as const;

const num = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().finite()).catch(0);

export const RawGuideBubbleSchema = z.object({
  order: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().positive()).optional().catch(undefined),
  box: z.object({ left: num, top: num, right: num, bottom: num }),
  blockIndex: optNumber,
  text: reqString,
  speaker: optString,
  translation: reqString,
  note: optString,
});

export const RawPageGuideSchema = z.object({
  summary: reqString,
  bubbles: arrayOf(RawGuideBubbleSchema),
});
export type RawPageGuide = z.infer<typeof RawPageGuideSchema>;

const N = { type: 'NUMBER' } as const;
export const PAGE_GUIDE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: S,
    bubbles: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          order: { type: 'INTEGER' },
          box: { type: 'OBJECT', properties: { left: N, top: N, right: N, bottom: N }, required: ['left', 'top', 'right', 'bottom'], propertyOrdering: ['left', 'top', 'right', 'bottom'] },
          blockIndex: { type: 'INTEGER' },
          text: S,
          speaker: S,
          translation: S,
          note: S,
        },
        required: ['order', 'box', 'text', 'translation'],
        propertyOrdering: ['order', 'box', 'blockIndex', 'text', 'speaker', 'translation', 'note'],
      },
    },
  },
  required: ['summary', 'bubbles'],
  propertyOrdering: ['summary', 'bubbles'],
} as const;

/**
 * Strip optional Markdown code fences and parse JSON. Throws a plain `Error`
 * on failure (callers map it to `ai-invalid-response`).
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? (fenced[1] ?? '') : trimmed);
}
