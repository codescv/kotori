/**
 * UI-local subtitle helpers that mirror the `@kotori/core/subtitle` contract
 * (ARCHITECTURE.md §4.2). They are pure, dependency-free ports so the UI can be
 * built and tested against the type contract before `feat/core` lands; once core
 * is merged these can be swapped for the core exports one-for-one (same names,
 * same semantics).
 */
import type { CharSpan, ExplainSource, MergedCueGroups, SubtitleCue, TranscriptRow } from '@kotori/core';

/** Characters that end a sentence; a following cue then starts on a new line. */
const TERMINAL_RE = /[。！？!?…♪」』）)]\s*$/u;
/** Characters that open a new utterance (speaker change / quote). */
const OPENER_RE = /^[\s「『（(―\-－]/u;

export interface MergedSentence {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly cueIndexes: readonly number[];
  readonly cueCharSpans: readonly CharSpan[];
}

/**
 * Join several cues into one explainable sentence. Cues are joined without a
 * separator when the previous text has no terminal punctuation and the next
 * one continues it; otherwise with `\n`. `cueCharSpans[k]` is cue `k`'s span in
 * the merged text (separators belong to no cue).
 */
export function mergeCuesToSentence(cues: readonly SubtitleCue[]): MergedSentence {
  let text = '';
  const spans: CharSpan[] = [];
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  cues.forEach((cue, k) => {
    if (k > 0) {
      const continues = !TERMINAL_RE.test(text) && !OPENER_RE.test(cue.text);
      if (!continues) text += '\n';
    }
    const start = text.length;
    text += cue.text;
    spans.push([start, text.length]);
    startMs = Math.min(startMs, cue.startMs);
    endMs = Math.max(endMs, cue.endMs);
  });
  return {
    text,
    startMs: Number.isFinite(startMs) ? startMs : 0,
    endMs,
    cueIndexes: cues.map((c) => c.index),
    cueCharSpans: spans,
  };
}

type SubtitleSource = Extract<ExplainSource, { kind: 'subtitle' }>;

/** Overlay/transcript click `(cueIndex, localCharIndex)` → index into the explained sentence. */
export function cueOffsetToSentenceIndex(source: SubtitleSource, cueIndex: number, localCharIndex: number): number {
  const k = source.cueIndexes.indexOf(cueIndex);
  const span = source.cueCharSpans[k];
  if (k < 0 || !span) return Math.max(0, localCharIndex);
  const len = span[1] - span[0];
  return span[0] + Math.min(Math.max(0, localCharIndex), Math.max(0, len - 1));
}

/** Inverse of {@link cueOffsetToSentenceIndex}; `undefined` for separator positions. */
export function sentenceIndexToCueOffset(
  source: SubtitleSource,
  sentenceIndex: number,
): { readonly cueIndex: number; readonly localCharIndex: number } | undefined {
  for (let k = 0; k < source.cueCharSpans.length; k++) {
    const span = source.cueCharSpans[k];
    const cueIndex = source.cueIndexes[k];
    if (span && cueIndex !== undefined && sentenceIndex >= span[0] && sentenceIndex < span[1]) {
      return { cueIndex, localCharIndex: sentenceIndex - span[0] };
    }
  }
  return undefined;
}

/** Index of the last cue whose window contains `ms` (binary search over startMs). -1 when none. */
export function cueIndexAt(cues: readonly SubtitleCue[], ms: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (!cue) break;
    if (cue.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Walk back over overlapping cues to find one that is actually on screen.
  for (let i = found; i >= 0 && i > found - 8; i--) {
    const cue = cues[i];
    if (cue && cue.startMs <= ms && ms < cue.endMs) return i;
  }
  return -1;
}

/** All cue positions on screen at `ms`, ascending. */
export function activeCueIndexes(cues: readonly SubtitleCue[], ms: number): number[] {
  const out: number[] = [];
  cues.forEach((cue, i) => {
    if (cue.startMs <= ms && ms < cue.endMs) out.push(i);
  });
  return out;
}

/** First cue starting strictly after `ms` (array position), or -1. */
export function nextCueIndex(cues: readonly SubtitleCue[], ms: number): number {
  return cues.findIndex((c) => c.startMs > ms + 1);
}

/** Last cue starting strictly before the current one at `ms` (array position), or -1. */
export function prevCueIndex(cues: readonly SubtitleCue[], ms: number): number {
  const current = cueIndexAt(cues, ms);
  const pivot = current >= 0 ? (cues[current]?.startMs ?? ms) : ms;
  for (let i = cues.length - 1; i >= 0; i--) {
    const cue = cues[i];
    if (cue && cue.startMs < pivot - 1) return i;
  }
  return -1;
}

/** Number of user-perceived characters (grapheme clusters). */
export function graphemeCount(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)) n++;
    return n;
  }
  return Array.from(text).length;
}

/**
 * Fold ASS per-character karaoke events back into sentences (port of Fushi
 * `mergePerCharacterCueGroups`): single-grapheme `\pos` cues on the same row
 * and layer whose time intersects the group's shrinking common window.
 */
export function mergePerCharacterCueGroups(cues: readonly SubtitleCue[]): MergedCueGroups {
  const byRep = new Map<number, SubtitleCue>();
  const repByRaw = new Map<number, number>();
  const isPerChar = (c: SubtitleCue): boolean => c.markup?.posFraction !== undefined && graphemeCount(c.text) === 1;
  let i = 0;
  while (i < cues.length) {
    const head = cues[i];
    if (!head || !isPerChar(head)) {
      i++;
      continue;
    }
    const headY = head.markup?.posFraction?.yFraction ?? 0;
    const headLayer = head.markup?.layer ?? 0;
    const group: SubtitleCue[] = [head];
    let unionStart = head.startMs;
    let unionEnd = head.endMs;
    let liveStart = head.startMs;
    let liveEnd = head.endMs;
    let j = i + 1;
    while (j < cues.length) {
      const c = cues[j];
      if (!c || !isPerChar(c)) break;
      if ((c.markup?.layer ?? 0) !== headLayer) break;
      if (Math.abs((c.markup?.posFraction?.yFraction ?? 0) - headY) > 0.001) break;
      if (c.startMs > liveEnd || c.endMs < liveStart) break;
      group.push(c);
      unionStart = Math.min(unionStart, c.startMs);
      unionEnd = Math.max(unionEnd, c.endMs);
      liveStart = Math.max(liveStart, c.startMs);
      liveEnd = Math.min(liveEnd, c.endMs);
      j++;
    }
    if (group.length >= 2) {
      const ordered = [...group].sort(
        (a, b) => (a.markup?.posFraction?.xFraction ?? 0) - (b.markup?.posFraction?.xFraction ?? 0),
      );
      for (let k = i; k < j; k++) {
        const raw = cues[k];
        if (raw) repByRaw.set(raw.index, head.index);
      }
      byRep.set(head.index, {
        index: head.index,
        startMs: unionStart,
        endMs: unionEnd,
        text: ordered.map((c) => c.text).join(''),
        rawText: ordered.map((c) => c.rawText).join(''),
      });
    }
    i = j > i ? j : i + 1;
  }
  return { byRep, repByRaw };
}

export interface TranscriptOptions {
  readonly mergeKaraoke: boolean;
  readonly hideSigns: boolean;
  readonly chainFoldGapMs?: number;
}

/**
 * Build the transcript rows: karaoke merge → exact `(startMs, text)` de-dup →
 * adjacency-chain fold of same-text cues → optional sign/comment filtering.
 */
export function buildTranscriptRows(cues: readonly SubtitleCue[], opts: TranscriptOptions): TranscriptRow[] {
  const gap = opts.chainFoldGapMs ?? 40;
  const merged = opts.mergeKaraoke ? mergePerCharacterCueGroups(cues) : { byRep: new Map(), repByRaw: new Map() };
  const byIndex = new Map<number, SubtitleCue>();
  for (const c of cues) byIndex.set(c.index, c);

  const reps: number[] = [];
  const rawByRep = new Map<number, number[]>();
  const firstByKey = new Map<string, number>();
  const push = (rep: number, raw: number): void => {
    const list = rawByRep.get(rep);
    if (list) list.push(raw);
    else rawByRep.set(rep, [raw]);
  };
  for (const cue of cues) {
    const mergedRep = merged.repByRaw.get(cue.index);
    if (mergedRep !== undefined) {
      if (mergedRep === cue.index) reps.push(cue.index);
      push(mergedRep, cue.index);
      continue;
    }
    const key = `${cue.startMs}\u0000${cue.text}`;
    const rep = firstByKey.get(key);
    if (rep === undefined) {
      firstByKey.set(key, cue.index);
      reps.push(cue.index);
      push(cue.index, cue.index);
    } else push(rep, cue.index);
  }

  const rows: { rep: number; cue: SubtitleCue; rawIndexes: number[]; chainEndMs: number }[] = [];
  const openChains = new Map<string, { row: (typeof rows)[number] }>();
  for (const rep of reps) {
    const cue = merged.byRep.get(rep) ?? byIndex.get(rep);
    if (!cue) continue;
    const raws = rawByRep.get(rep) ?? [rep];
    const chain = openChains.get(cue.text);
    if (chain && cue.startMs <= chain.row.chainEndMs + gap) {
      chain.row.rawIndexes.push(...raws);
      chain.row.chainEndMs = Math.max(chain.row.chainEndMs, cue.endMs);
      continue;
    }
    const row = { rep, cue, rawIndexes: [...raws], chainEndMs: cue.endMs };
    openChains.set(cue.text, { row });
    rows.push(row);
  }

  return rows.filter((row) => {
    if (!opts.hideSigns) return true;
    const m = row.cue.markup;
    if (row.cue.text.trim() === '') return false;
    return !(m && (m.isDrawing || m.hasMove || m.isComment));
  });
}

/** `m:ss` or `h:mm:ss`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
