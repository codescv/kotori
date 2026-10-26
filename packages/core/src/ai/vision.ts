/**
 * Manga vision calls (Gemini multimodal): bubble OCR and whole-page guide.
 */
import type { MangaBubbleOcrRequest, MangaBubbleOcrResult, MangaGuideBubble, MangaPageGuideRequest, MangaPageGuideResult, MangaRectFraction, SentenceExplanation } from '../types';
import { BUBBLE_OCR_RESPONSE_SCHEMA, PAGE_GUIDE_RESPONSE_SCHEMA, RawBubbleOcrSchema, RawPageGuideSchema } from './explain-schema';
import type { GeminiClient } from './gemini-client';
import { buildBubbleOcrPrompt, buildPageGuidePrompt } from './prompts';
import { generateStructured } from './structured';

export interface VisionOptions {
  /** Vision model (`AiSettings.visionModel`). */
  readonly model: string;
  readonly temperature?: number;
  readonly thinkingBudget?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /**
   * Explain pipeline used when `req.explain` is true (the explain service
   * passes its own `explain`). Skipped when absent or the OCR text is empty.
   */
  readonly explain?: (sentence: string, signal?: AbortSignal) => Promise<SentenceExplanation>;
}

/** Clamp to 0..1 (NaN → 0). */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Normalise a model box to a 0..1 `MangaRectFraction`. Boxes are requested
 * on a 0..1000 scale; boxes whose coordinates are all ≤ 1 are taken as
 * fractions already. Inverted edges are swapped.
 */
export function boxToRectFraction(box: { left: number; top: number; right: number; bottom: number }): MangaRectFraction {
  const values = [box.left, box.top, box.right, box.bottom];
  const scale = values.every((v) => Math.abs(v) <= 1) ? 1 : 1000;
  const l = clamp01(box.left / scale);
  const t = clamp01(box.top / scale);
  const r = clamp01(box.right / scale);
  const b = clamp01(box.bottom / scale);
  return { left: Math.min(l, r), top: Math.min(t, b), right: Math.max(l, r), bottom: Math.max(t, b) };
}

/** Shared generation options from `VisionOptions`. */
function genOptions(opts: VisionOptions): { temperature?: number; thinkingBudget?: number; timeoutMs?: number } {
  const o: { temperature?: number; thinkingBudget?: number; timeoutMs?: number } = {};
  if (opts.temperature !== undefined) o.temperature = opts.temperature;
  if (opts.thinkingBudget !== undefined) o.thinkingBudget = opts.thinkingBudget;
  if (opts.timeoutMs !== undefined) o.timeoutMs = opts.timeoutMs;
  return o;
}

/**
 * OCR a cropped speech bubble. `text = lines.join('')`. When `req.explain`
 * is set, the recognised text is run through `opts.explain` in the same call.
 */
export async function ocrBubble(client: GeminiClient, req: MangaBubbleOcrRequest, opts: VisionOptions): Promise<MangaBubbleOcrResult> {
  const prompt = buildBubbleOcrPrompt(req);
  const res = await generateStructured(
    client,
    { model: opts.model, ...prompt, responseSchema: BUBBLE_OCR_RESPONSE_SCHEMA, ...genOptions(opts) },
    RawBubbleOcrSchema,
    opts.signal,
  );
  const lines = res.value.lines.map((l) => l.trim()).filter((l) => l !== '');
  const text = lines.join('');
  const out: { -readonly [K in keyof MangaBubbleOcrResult]: MangaBubbleOcrResult[K] } = {
    volumeId: req.volumeId,
    pageIndex: req.pageIndex,
    rect: req.rect,
    lines,
    text,
    vertical: res.value.vertical,
    model: res.model,
    createdAt: (opts.now ?? Date.now)(),
  };
  if (res.value.confidence !== undefined) out.confidence = clamp01(res.value.confidence);
  if (res.usage) out.usage = res.usage;
  if (req.explain && opts.explain && text) out.explanation = await opts.explain(text, opts.signal);
  return out;
}

/**
 * Whole-page reading guide: bubbles in reading order with normalised boxes
 * (`rectFraction` clamped to 0..1) and optional `blockIndex` matches.
 */
export async function pageGuide(client: GeminiClient, req: MangaPageGuideRequest, opts: VisionOptions): Promise<MangaPageGuideResult> {
  const prompt = buildPageGuidePrompt(req);
  const res = await generateStructured(
    client,
    { model: opts.model, ...prompt, responseSchema: PAGE_GUIDE_RESPONSE_SCHEMA, ...genOptions(opts) },
    RawPageGuideSchema,
    opts.signal,
  );
  const knownCount = req.knownBlocks?.length ?? 0;
  const knownIndexes = new Set((req.knownBlocks ?? []).map((b) => b.index));
  const bubbles = res.value.bubbles
    .map((b, i) => ({ b, order: b.order ?? i + 1, i }))
    .sort((x, y) => x.order - y.order || x.i - y.i)
    .map(({ b }, k): MangaGuideBubble => {
      const out: { -readonly [K in keyof MangaGuideBubble]: MangaGuideBubble[K] } = {
        order: k + 1,
        rectFraction: boxToRectFraction(b.box),
        text: b.text,
        translation: b.translation,
      };
      if (b.blockIndex !== undefined && knownCount > 0 && knownIndexes.has(Math.trunc(b.blockIndex))) out.blockIndex = Math.trunc(b.blockIndex);
      if (b.speaker !== undefined) out.speaker = b.speaker;
      if (b.note !== undefined) out.note = b.note;
      return out;
    });
  const out: { -readonly [K in keyof MangaPageGuideResult]: MangaPageGuideResult[K] } = {
    volumeId: req.volumeId,
    pageIndex: req.pageIndex,
    bubbles,
    summary: res.value.summary,
    model: res.model,
    createdAt: (opts.now ?? Date.now)(),
  };
  if (res.usage) out.usage = res.usage;
  return out;
}
