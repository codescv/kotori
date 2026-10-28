/**
 * Renders a sentence as `<ruby>base<rt>reading</rt></ruby>` segments while
 * keeping every grapheme individually addressable:
 *
 * - each segment and each character carries `data-char-start` / `data-char-end`
 *   (UTF-16, half-open, in the coordinate space of `text`);
 * - a click on a character reports its exact `charIndex`; a click on a reading
 *   (`<rt>`) reports the segment start; a click elsewhere falls back to
 *   `caretPositionFromPoint` / `caretRangeFromPoint` / `elementsFromPoint`;
 * - `highlight` (a `CharSpan`) paints the active chunk, `focusIndex` the caret;
 * - furigana follows `settings.anime.furiganaMode`: `'all'` (default) shows
 *   every `<rt>`, `'off'` hides them, `'tap'` keeps them veiled until that
 *   word is hovered or tapped (layout and hit mapping stay identical).
 */
import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { CharSpan, RubySegment } from '@kotori/core';
import { useSettingsStore } from '../../stores/settings';
import { cx } from '../m3/cx';
import './breakdown.css';

export interface RubyTextProps {
  readonly text: string;
  readonly segments?: readonly RubySegment[] | undefined;
  /** Active span to highlight (e.g. the focused chunk). */
  readonly highlight?: CharSpan | undefined;
  /** UTF-16 index of the clicked character. */
  readonly focusIndex?: number | undefined;
  /** UTF-16 span of the focused word (overrides automatic word-span inference from `focusIndex`). */
  readonly focusSpan?: CharSpan | undefined;
  readonly onCharClick?: ((charIndex: number) => void) | undefined;
  /** Hide `<rt>` readings (keeps layout & hit mapping identical). */
  readonly showRuby?: boolean;
  /** Offset added to reported/compared indices (render a slice of a longer sentence). */
  readonly offset?: number;
  readonly className?: string | undefined;
  readonly lang?: string;
  readonly 'data-testid'?: string;
}

interface Glyph {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface Seg {
  readonly base: string;
  readonly ruby?: string | undefined;
  readonly start: number;
  readonly end: number;
  readonly glyphs: readonly Glyph[];
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : undefined;

const jaWordSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;

function isKatakanaChar(ch: string): boolean {
  return /^[\u30A1-\u30FA\u30FC-\u30FEー]$/.test(ch);
}

function isKanjiChar(ch: string): boolean {
  return /^([\u4E00-\u9FFF\u3400-\u4DBF々ヶヵ]|\p{Script=Han})$/u.test(ch);
}

function isPunctOrSpace(ch: string): boolean {
  if (isKatakanaChar(ch) || isKanjiChar(ch) || /^[\u309D\u309E]$/.test(ch)) return false;
  return /^[\s\u3000-\u303F\uFF00-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\p{P}\p{S}]$/u.test(ch);
}

function prevCodePointSlice(text: string, pos: number): string {
  if (pos >= 2) {
    const hi = text.charCodeAt(pos - 2);
    const lo = text.charCodeAt(pos - 1);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
      return text.slice(pos - 2, pos);
    }
  }
  return text[pos - 1] ?? '';
}

function codePointSliceAt(text: string, pos: number): string {
  const cp = text.codePointAt(pos);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * Synchronous word-boundary helper for highlighting an entire Japanese word
 * (e.g. `"ライブハウス"`, `"女子"`, `"食べた"`) when any character inside it is tapped.
 */
export function inferWordSpanAt(
  text: string,
  charIndex: number,
  segments?: readonly RubySegment[],
  offset = 0,
): CharSpan | undefined {
  const localIdx = charIndex - offset;
  if (localIdx < 0 || localIdx >= text.length) return undefined;
  const ch = codePointSliceAt(text, localIdx);
  if (!ch) return undefined;
  if (isPunctOrSpace(ch)) return [charIndex, charIndex + ch.length];

  // Rule A — Contiguous Katakana Run (critical so compound loanwords like "ライブハウス" stay together).
  if (
    isKatakanaChar(ch) &&
    (ch !== 'ー' ||
      (localIdx > 0 && isKatakanaChar(text[localIdx - 1]!)) ||
      (localIdx + 1 < text.length && isKatakanaChar(text[localIdx + 1]!)))
  ) {
    let start = localIdx;
    let end = localIdx + ch.length;
    while (start > 0 && isKatakanaChar(text[start - 1]!)) start--;
    while (end < text.length && isKatakanaChar(text[end]!)) end++;
    return [start + offset, end + offset];
  }

  // Rule B — RubySegment & Kanji + Intl.Segmenter('ja', { granularity: 'word' }).
  let start = localIdx;
  let end = localIdx + ch.length;

  if (segments) {
    for (const seg of segments) {
      if (seg.ruby && seg.ruby.length > 0 && seg.charSpan[0] <= charIndex && charIndex < seg.charSpan[1]) {
        start = Math.min(start, Math.max(0, seg.charSpan[0] - offset));
        end = Math.max(end, Math.min(text.length, seg.charSpan[1] - offset));
      }
    }
  }

  if (jaWordSegmenter) {
    for (const seg of jaWordSegmenter.segment(text)) {
      const segEnd = seg.index + seg.segment.length;
      if (seg.index <= localIdx && localIdx < segEnd) {
        if (seg.isWordLike) {
          start = Math.min(start, seg.index);
          end = Math.max(end, segEnd);
        }
        break;
      }
    }
  } else if (isKanjiChar(ch)) {
    while (start > 0) {
      const prev = prevCodePointSlice(text, start);
      if (!prev || !isKanjiChar(prev)) break;
      start -= prev.length;
    }
    while (end < text.length) {
      const next = codePointSliceAt(text, end);
      if (!next || !isKanjiChar(next)) break;
      end += next.length;
    }
  }

  return [start + offset, end + offset];
}

function glyphsOf(base: string, start: number): Glyph[] {
  const out: Glyph[] = [];
  let pos = start;
  const parts = segmenter ? Array.from(segmenter.segment(base), (s) => s.segment) : Array.from(base);
  for (const g of parts) {
    out.push({ text: g, start: pos, end: pos + g.length });
    pos += g.length;
  }
  return out;
}

/**
 * Normalise segments so they tile `[0, text.length)` exactly: sorted, clipped,
 * and gaps filled with ruby-less segments taken from `text` itself.
 */
export function tileSegments(text: string, segments: readonly RubySegment[] | undefined, offset = 0): Seg[] {
  const out: Seg[] = [];
  let cursor = 0;
  const sorted = [...(segments ?? [])].sort((a, b) => a.charSpan[0] - b.charSpan[0]);
  const pushPlain = (from: number, to: number): void => {
    if (to <= from) return;
    const base = text.slice(from, to);
    out.push({ base, start: from + offset, end: to + offset, glyphs: glyphsOf(base, from + offset) });
  };
  for (const s of sorted) {
    const start = Math.max(cursor, s.charSpan[0] - offset);
    const end = Math.min(text.length, s.charSpan[1] - offset);
    if (end <= start) continue;
    pushPlain(cursor, start);
    const base = text.slice(start, end);
    // Readings only make sense for the whole base; drop them for clipped segments.
    const whole = start === s.charSpan[0] - offset && end === s.charSpan[1] - offset;
    out.push({
      base,
      ruby: whole ? s.ruby : undefined,
      start: start + offset,
      end: end + offset,
      glyphs: glyphsOf(base, start + offset),
    });
    cursor = end;
  }
  pushPlain(cursor, text.length);
  return out;
}

const attrInt = (el: Element, name: string): number | undefined => {
  const v = el.getAttribute(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Map a DOM node inside a RubyText to its UTF-16 char index (`undefined` if none). */
export function charIndexFromNode(node: Node | null, root: Element): number | undefined {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el && el !== root.parentElement) {
    if (el.tagName === 'RT' || el.tagName === 'RP') {
      // Reading clicked → segment start.
      const ruby = el.closest('[data-char-start]');
      return ruby ? attrInt(ruby, 'data-char-start') : undefined;
    }
    const start = attrInt(el, 'data-char-start');
    if (start !== undefined) return start;
    if (el === root) break;
    el = el.parentElement;
  }
  return undefined;
}

interface CaretDoc {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** Fallback hit test for clicks that land between glyphs (padding, line gaps). */
function charIndexFromPoint(root: Element, x: number, y: number): number | undefined {
  const doc = root.ownerDocument as Document & CaretDoc;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos?.offsetNode && root.contains(pos.offsetNode)) return charIndexFromNode(pos.offsetNode, root);
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range && root.contains(range.startContainer)) return charIndexFromNode(range.startContainer, root);
  const els = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : [];
  for (const el of els) {
    if (root.contains(el) && el !== root) {
      const i = charIndexFromNode(el, root);
      if (i !== undefined) return i;
    }
  }
  // Nearest glyph by geometry.
  let best: number | undefined;
  let bestD = Infinity;
  root.querySelectorAll('[data-glyph]').forEach((g) => {
    const r = g.getBoundingClientRect();
    const d = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = attrInt(g, 'data-char-start');
    }
  });
  return best;
}

function RubyTextImpl({
  text,
  segments,
  highlight,
  focusIndex,
  focusSpan,
  onCharClick,
  showRuby = true,
  offset = 0,
  className,
  lang = 'ja',
  'data-testid': testId,
}: RubyTextProps) {
  const segs = useMemo(() => tileSegments(text, segments, offset), [text, segments, offset]);
  const resolvedFocusSpan = useMemo<CharSpan | undefined>(
    () => focusSpan ?? (focusIndex !== undefined ? inferWordSpanAt(text, focusIndex, segments, offset) : undefined),
    [focusSpan, focusIndex, text, segments, offset],
  );
  const furiganaMode = useSettingsStore((s) => s.settings.anime.furiganaMode ?? 'all');
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const reveal = useCallback((start: number) => setRevealed((prev) => (prev.has(start) ? prev : new Set(prev).add(start))), []);
  const tapMode = furiganaMode === 'tap';
  // A new sentence starts fully veiled again.
  useEffect(() => setRevealed((prev) => (prev.size === 0 ? prev : new Set())), [text]);
  const inHl = (start: number): boolean => highlight !== undefined && start >= highlight[0] && start < highlight[1];
  const inFocus = (pos: number): boolean => resolvedFocusSpan !== undefined && pos >= resolvedFocusSpan[0] && pos < resolvedFocusSpan[1];

  const onClick = (e: MouseEvent<HTMLSpanElement>): void => {
    if (tapMode) {
      const ruby = (e.target as Element | null)?.closest?.('ruby[data-char-start]');
      const start = ruby ? attrInt(ruby, 'data-char-start') : undefined;
      if (start !== undefined) reveal(start);
    }
    if (!onCharClick) return;
    const root = e.currentTarget;
    const idx = charIndexFromNode(e.target as Node, root) ?? charIndexFromPoint(root, e.clientX, e.clientY);
    if (idx !== undefined) onCharClick(idx);
  };

  return (
    <span
      className={cx(
        'k-ruby-text',
        onCharClick && 'is-clickable',
        (!showRuby || furiganaMode === 'off') && 'hide-ruby',
        tapMode && 'is-ruby-tap',
        className,
      )}
      data-furigana={furiganaMode}
      lang={lang}
      onClick={onClick}
      data-testid={testId}
    >
      {segs.map((seg) => {
        const glyphs = seg.glyphs.map((g) => {
          if (g.text === '\n') {
            return <br key={g.start} data-char-start={g.start} data-char-end={g.end} />;
          }
          const isFocused =
            inFocus(g.start) || (resolvedFocusSpan === undefined && focusIndex !== undefined && focusIndex >= g.start && focusIndex < g.end);
          return (
            <span
              key={g.start}
              data-glyph=""
              data-char-start={g.start}
              data-char-end={g.end}
              className={cx(
                'k-glyph',
                inHl(g.start) && 'is-hl',
                inHl(g.start) && !inHl(g.start - 1) && 'is-hl-start',
                inHl(g.start) && !inHl(g.end) && 'is-hl-end',
                isFocused && 'is-focus',
                isFocused && (resolvedFocusSpan === undefined || !inFocus(g.start - 1)) && 'is-focus-start',
                isFocused && (resolvedFocusSpan === undefined || !inFocus(g.end)) && 'is-focus-end',
              )}
            >
              {g.text}
            </span>
          );
        });
        const segHl = highlight !== undefined && seg.start < highlight[1] && seg.end > highlight[0];
        return seg.ruby ? (
          <ruby key={seg.start} className={cx('k-ruby', segHl && 'is-hl', tapMode && revealed.has(seg.start) && 'is-revealed')} data-char-start={seg.start} data-char-end={seg.end}>
            {glyphs}
            <rp>(</rp>
            <rt>{seg.ruby}</rt>
            <rp>)</rp>
          </ruby>
        ) : (
          <span key={seg.start} className="k-seg" data-char-start={seg.start} data-char-end={seg.end}>
            {glyphs}
          </span>
        );
      })}
    </span>
  );
}

export const RubyText = memo(RubyTextImpl);
