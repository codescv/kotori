/**
 * Transcript / jump-panel rows. Port of Fushi `subtitleTranscriptRows`
 * (fushi/lib/src/media/video/video_subtitle_jump_panel.dart, TODO-1384 /
 * BUG-1776) plus Kotori's `hideSigns` filter.
 */
import type { MergedCueGroups, SubtitleCue, TranscriptRow } from '../types';
import { mergePerCharacterCueGroups } from './merge-per-char';

/** Options of {@link buildTranscriptRows}. */
export interface TranscriptOptions {
  /** Fold ASS per-character karaoke events into whole lines. */
  readonly mergeKaraoke: boolean;
  /** Drop typesetting: drawings (`\p1`), `\move` signs, `Comment:` events and empty text. */
  readonly hideSigns: boolean;
  /** Max gap between a chain's end and the next same-text cue for adjacency folding (default 40 ms). */
  readonly chainFoldGapMs?: number;
}

/** Default adjacency-chain gap (BUG-1776): karaoke alternating layers touch exactly (gap 0). */
export const DEFAULT_CHAIN_FOLD_GAP_MS = 40;

/** Typesetting / non-dialogue cue that `hideSigns` removes. */
function isSign(cue: SubtitleCue): boolean {
  const m = cue.markup;
  return cue.text.trim() === '' || m?.isDrawing === true || m?.hasMove === true || m?.isComment === true;
}

/**
 * Build the transcript rows for a track. Keys / `rep` / `rawIndexes` are array
 * positions (parsers guarantee `cues[k].index === k`). Steps:
 *
 * 1. karaoke merge ({@link mergePerCharacterCueGroups}) when `mergeKaraoke`;
 *    group members map to the group head;
 * 2. exact `(startMs, text)` de-duplication (stacked layers / duplicated lines
 *    map to the first occurrence);
 * 3. adjacency-chain fold: per text, a representative whose `startMs ≤
 *    chainEnd + chainFoldGapMs` joins that text's open chain (row = chain
 *    head, `chainEndMs` = chain end); otherwise it opens a new chain;
 * 4. `hideSigns` removes drawings, `\move` signs, comments and empty text. The
 *    filter is applied before steps 2–3 so a hidden cue can never become the
 *    representative of a visible duplicate (e.g. a `Comment:` copy of a line).
 *    A karaoke group is hidden when its head is.
 */
export function buildTranscriptRows(cues: readonly SubtitleCue[], opts: TranscriptOptions): TranscriptRow[] {
  const gapMs = opts.chainFoldGapMs ?? DEFAULT_CHAIN_FOLD_GAP_MS;
  const merged: MergedCueGroups = opts.mergeKaraoke
    ? mergePerCharacterCueGroups(cues)
    : { byRep: new Map<number, SubtitleCue>(), repByRaw: new Map<number, number>() };

  // Pass 1: karaoke groups + exact (startMs, text) de-dup.
  const reps: number[] = [];
  const firstByKey = new Map<string, number>();
  const repByRaw = new Map<number, number>();
  for (let i = 0; i < cues.length; i++) {
    const mergedRep = merged.repByRaw.get(i);
    if (mergedRep !== undefined) {
      const head = cues[mergedRep] as SubtitleCue;
      const groupCue = merged.byRep.get(mergedRep) ?? head;
      if (opts.hideSigns && (isSign(head) || isSign(groupCue))) continue;
      repByRaw.set(i, mergedRep);
      if (mergedRep === i) reps.push(i);
      continue;
    }
    const cue = cues[i] as SubtitleCue;
    if (opts.hideSigns && isSign(cue)) continue;
    const key = `${cue.startMs}\u0000${cue.text}`;
    const rep = firstByKey.get(key);
    if (rep === undefined) {
      firstByKey.set(key, i);
      repByRaw.set(i, i);
      reps.push(i);
    } else {
      repByRaw.set(i, rep);
    }
  }

  // Pass 2: adjacency-chain fold, one open chain per text.
  const chainByRep = new Map<number, number>();
  const chainEndMsByRep = new Map<number, number>();
  const chained: number[] = [];
  const openChains = new Map<string, { head: number; endMs: number }>();
  for (const rep of reps) {
    const c = merged.byRep.get(rep) ?? (cues[rep] as SubtitleCue);
    const chain = openChains.get(c.text);
    if (chain !== undefined && c.startMs <= chain.endMs + gapMs) {
      chainByRep.set(rep, chain.head);
      const endMs = Math.max(c.endMs, chain.endMs);
      openChains.set(c.text, { head: chain.head, endMs });
      chainEndMsByRep.set(chain.head, endMs);
    } else {
      openChains.set(c.text, { head: rep, endMs: c.endMs });
      chained.push(rep);
    }
  }

  // Collect every raw index under its final row (ascending, since keys were inserted ascending).
  const rawByRow = new Map<number, number[]>();
  for (const [raw, rep] of repByRaw) {
    const row = chainByRep.get(rep) ?? rep;
    const list = rawByRow.get(row);
    if (list) list.push(raw);
    else rawByRow.set(row, [raw]);
  }

  return chained.map((rep) => {
    const cue = merged.byRep.get(rep) ?? (cues[rep] as SubtitleCue);
    return {
      rep,
      cue,
      rawIndexes: rawByRow.get(rep) ?? [rep],
      chainEndMs: chainEndMsByRep.get(rep) ?? cue.endMs,
    };
  });
}

/** A transcript line as seen by {@link buildSubtitleContext}. */
export interface SubtitleContextRow {
  readonly text: string;
  /** ASS actor / speaker name, when known. */
  readonly actor?: string | undefined;
}

/** Context lines (and speaker) for explaining row `index`. */
export interface SubtitleContext {
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
  /** Trimmed actor of the target row, when non-empty. */
  readonly speaker?: string | undefined;
}

/** `[Actor] text` (or just `text`), single-line, trimmed. */
function formatContextLine(row: SubtitleContextRow): string {
  const text = row.text.replace(/\s*\r?\n\s*/g, ' ').trim();
  const actor = row.actor?.trim();
  return actor ? `[${actor}] ${text}` : text;
}

/**
 * Shared context builder for subtitle explain requests. Single-sentence
 * explain and batch pre-explain MUST both use it so the same line always gets
 * identical `contextBefore` / `contextAfter` (and therefore the same prompt).
 * Lines are formatted `[Actor] text` when the row has a non-empty actor;
 * empty rows are skipped without shrinking the window.
 */
export function buildSubtitleContext(
  rows: readonly SubtitleContextRow[],
  index: number,
  beforeCount = 2,
  afterCount = 1,
): SubtitleContext {
  const contextBefore: string[] = [];
  for (let k = index - 1; k >= 0 && contextBefore.length < beforeCount; k--) {
    const row = rows[k];
    if (!row) continue;
    const line = formatContextLine(row);
    if (line !== '') contextBefore.unshift(line);
  }
  const contextAfter: string[] = [];
  for (let k = index + 1; k < rows.length && contextAfter.length < afterCount; k++) {
    const row = rows[k];
    if (!row) continue;
    const line = formatContextLine(row);
    if (line !== '') contextAfter.push(line);
  }
  const speaker = rows[index]?.actor?.trim();
  return speaker ? { contextBefore, contextAfter, speaker } : { contextBefore, contextAfter };
}
