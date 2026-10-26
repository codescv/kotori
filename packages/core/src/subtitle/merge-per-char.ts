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
  return { byRep, repByRaw };
}
