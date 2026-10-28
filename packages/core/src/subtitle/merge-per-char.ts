/**
 * Fold ASS per-character karaoke events back into whole lines for the
 * transcript. Exact port of Fushi `mergePerCharacterCueGroups`
 * (fushi/lib/src/media/video/video_subtitle_jump_panel.dart, TODO-1384 /
 * BUG-1439).
 */
import type { MergedCueGroups, SubtitleCue } from '../types';
import { graphemeCount } from '../util/graphemes';

/** Max `|Δ yFraction|` for two `\pos` events to count as the same row. */
const SAME_ROW_EPS = 0.001;

/** Typewriter pass: max graphemes per member cue. */
const TYPEWRITER_MAX_GRAPHEMES = 2;
/** Typewriter pass: min members in a run. */
const TYPEWRITER_MIN_RUN = 3;
/** Typewriter pass: allowed overlap of the next cue into the previous one (ms). */
const TYPEWRITER_OVERLAP_MS = 20;
/** Typewriter pass: max gap between consecutive cues (ms). */
const TYPEWRITER_MAX_GAP_MS = 120;
/** Typewriter pass: max total duration of a merged run (ms). */
const TYPEWRITER_MAX_TOTAL_MS = 10_000;

/** A short (≤ 2 grapheme, single-line, non-empty) cue that may be part of a typewriter run. */
function isTypewriterPiece(cue: SubtitleCue): boolean {
  const t = cue.text.trim();
  if (t === '' || cue.text.includes('\n')) return false;
  const m = cue.markup;
  if (m?.isDrawing === true || m?.isComment === true || m?.hasMove === true) return false;
  return graphemeCount(t) <= TYPEWRITER_MAX_GRAPHEMES;
}

/** Same ASS style + layer (both absent for SRT / VTT). */
function sameStyleLayer(a: SubtitleCue, b: SubtitleCue): boolean {
  return (a.markup?.styleName ?? '') === (b.markup?.styleName ?? '') && (a.markup?.layer ?? 0) === (b.markup?.layer ?? 0);
}

/** A karaoke "per-character" event: positioned with `\pos` and exactly one grapheme. */
function isPerCharCue(cue: SubtitleCue): boolean {
  return cue.markup?.posFraction !== undefined && graphemeCount(cue.text) === 1;
}

/**
 * Merge ASS per-character karaoke events (OP/ED lyrics split into one
 * `Dialogue` per character, each with its own `\pos`, e.g.
 * `{\an7\pos(461,672)\fad(250,250)}手`) back into sentences. Only the
 * transcript consumes this; the renderer keeps the raw per-char cues.
 *
 * A group is a run of consecutive cues (array order) that all: have
 * `markup.posFraction`; are a single grapheme; share the head's ASS layer;
 * have `|yFraction − head.yFraction| ≤ 0.001`; and intersect the group's
 * **common on-screen window** `[liveStart, liveEnd]`, which only shrinks
 * (comparing against the growing union instead chained whole songs together:
 * BUG-1439). Groups need ≥ 2 members.
 *
 * Keys are array positions (parsers guarantee `cues[k].index === k`).
 * `byRep` maps the group head to a synthesised cue whose text is the members
 * ordered by `xFraction` ascending, `startMs`/`endMs` the union, `index` the
 * head's and no `markup`. `repByRaw` maps every member (head included) to the
 * head. Non-members are skipped.
 */
export function mergePerCharacterCueGroups(cues: readonly SubtitleCue[]): MergedCueGroups {
  const byRep = new Map<number, SubtitleCue>();
  const repByRaw = new Map<number, number>();

  let i = 0;
  while (i < cues.length) {
    const head = cues[i] as SubtitleCue;
    if (!isPerCharCue(head)) {
      i++;
      continue;
    }
    const headY = head.markup?.posFraction?.yFraction ?? 0;
    const headLayer = head.markup?.layer ?? 0;
    const group: SubtitleCue[] = [head];
    // Union window → output; intersection ("live") window → grouping criterion.
    let unionStart = head.startMs;
    let unionEnd = head.endMs;
    let liveStart = head.startMs;
    let liveEnd = head.endMs;

    let j = i + 1;
    while (j < cues.length) {
      const c = cues[j] as SubtitleCue;
      if (!isPerCharCue(c)) break;
      if ((c.markup?.layer ?? 0) !== headLayer) break;
      if (Math.abs((c.markup?.posFraction?.yFraction ?? 0) - headY) > SAME_ROW_EPS) break;
      // Disjoint from the group's common on-screen window → next line.
      if (c.startMs > liveEnd || c.endMs < liveStart) break;
      group.push(c);
      if (c.startMs < unionStart) unionStart = c.startMs;
      if (c.endMs > unionEnd) unionEnd = c.endMs;
      if (c.startMs > liveStart) liveStart = c.startMs;
      if (c.endMs < liveEnd) liveEnd = c.endMs;
      j++;
    }

    if (group.length >= 2) {
      const ordered = [...group].sort(
        (a, b) => (a.markup?.posFraction?.xFraction ?? 0) - (b.markup?.posFraction?.xFraction ?? 0),
      );
      for (let k = i; k < j; k++) repByRaw.set(k, i);
      byRep.set(i, {
        index: head.index,
        startMs: unionStart,
        endMs: unionEnd,
        text: ordered.map((c) => c.text).join(''),
        rawText: group.map((c) => c.rawText).join('\n'),
        // markup deliberately omitted: the synthesised line has no single \pos / \fad.
      });
    }
    i = j > i ? j : i + 1;
  }

  mergeTypewriterRuns(cues, byRep, repByRaw);
  return { byRep, repByRaw };
}

/**
 * Second pass: fold *sequential* typewriter cues — a line revealed one or two
 * characters at a time, each in its own back-to-back cue (`こ` 0–80 ms, `ん`
 * 80–160 ms, …) — into one line. A run is ≥ 3 consecutive cues (array order)
 * not already grouped by the per-character pass that: are ≤ 2 graphemes;
 * share style and layer; follow each other with `next.startMs ≥ prev.endMs −
 * 20` and `next.startMs − prev.endMs ≤ 120`; and span ≤ 10 s in total. The
 * synthesised cue has `startMs = first.startMs`, `endMs = last.endMs` and the
 * members' text joined in order.
 */
function mergeTypewriterRuns(cues: readonly SubtitleCue[], byRep: Map<number, SubtitleCue>, repByRaw: Map<number, number>): void {
  let i = 0;
  while (i < cues.length) {
    const head = cues[i] as SubtitleCue;
    if (repByRaw.has(i) || !isTypewriterPiece(head)) {
      i++;
      continue;
    }
    let j = i + 1;
    let prev = head;
    while (j < cues.length) {
      const c = cues[j] as SubtitleCue;
      if (repByRaw.has(j) || !isTypewriterPiece(c) || !sameStyleLayer(head, c)) break;
      if (c.startMs < prev.endMs - TYPEWRITER_OVERLAP_MS || c.startMs - prev.endMs > TYPEWRITER_MAX_GAP_MS) break;
      if (c.endMs - head.startMs > TYPEWRITER_MAX_TOTAL_MS) break;
      prev = c;
      j++;
    }
    if (j - i >= TYPEWRITER_MIN_RUN) {
      const group = cues.slice(i, j);
      for (let k = i; k < j; k++) repByRaw.set(k, i);
      byRep.set(i, {
        index: head.index,
        startMs: head.startMs,
        endMs: prev.endMs,
        text: group.map((c) => c.text.trim()).join(''),
        rawText: group.map((c) => c.rawText).join('\n'),
      });
      i = j;
    } else {
      i++;
    }
  }
}
