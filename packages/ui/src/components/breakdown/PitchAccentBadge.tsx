/**
 * Dictionary badges for the breakdown panel:
 *
 * - `<PitchAccentBadge />` — moraic SVG pitch contour (Tokyo accent from a
 *   `term_meta_bank` pitch dictionary such as Kanjium): low/high dots per
 *   mora, a hollow particle dot (so 平板 [0] and 尾高 are distinguishable),
 *   connecting lines, a `┓` downstep marker after mora `position`, and an
 *   `[N]` badge. The tooltip lists every source dictionary.
 * - `<FreqBadge />` — corpus frequency rank (`[JPDB #3,851]`), labelled as a
 *   kana-orthography rank (`[JPDB かける(假名表记) #202]`) for JPDB `㋕` rows.
 */
import type { FrequencyBadge, MergedPitchGroup } from '@kotori/core';
import { useT } from '../../i18n';
import { cx } from '../m3/cx';

/** Small kana that merge into the preceding mora (っ/ッ and ー stay separate morae). */
const SMALL_KANA = new Set([...'ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ']);

/** Split a kana reading into morae: `しょうがっこう` → `しょ・う・が・っ・こ・う`. */
export function splitMorae(reading: string): string[] {
  const out: string[] = [];
  for (const ch of reading) {
    if (SMALL_KANA.has(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/**
 * High (`true`) / low (`false`) level for each of `moraCount` morae plus the
 * following particle (index `moraCount`), for downstep `position`
 * (0 = 平板, 1 = 頭高, n = 尾高, otherwise 中高).
 */
export function pitchLevels(moraCount: number, position: number): boolean[] {
  const n = Math.max(1, moraCount);
  const p = Math.max(0, Math.min(Math.floor(position), n));
  const out: boolean[] = [];
  for (let i = 0; i <= n; i++) {
    if (p === 0) out.push(i > 0);
    else if (p === 1) out.push(i === 0);
    else out.push(i > 0 && i < p);
  }
  return out;
}

const STEP = 18;
const PAD = 9;
const Y_HIGH = 6;
const Y_LOW = 20;
const LABEL_Y = 36;

function PitchContour({ group, testId }: { readonly group: MergedPitchGroup; readonly testId?: string | undefined }) {
  const morae = splitMorae(group.reading);
  const n = Math.max(1, morae.length);
  const levels = pitchLevels(n, group.position);
  const xs = levels.map((_, i) => PAD + i * STEP);
  const ys = levels.map((h) => (h ? Y_HIGH : Y_LOW));
  const width = PAD * 2 + n * STEP;
  const p = Math.max(0, Math.min(group.position, n));
  const sources = group.sources.join(', ');
  const moraPoints = xs
    .slice(0, n)
    .map((x, i) => `${x},${ys[i]}`)
    .join(' ');
  return (
    <span className="k-pitch__item" title={sources ? `${group.reading} [${group.position}] · ${sources}` : `${group.reading} [${group.position}]`} data-position={group.position} data-testid={testId}>
      <svg className="k-pitch__svg" width={width} height={40} viewBox={`0 0 ${width} 40`} role="img" aria-label={`${group.reading} [${group.position}]`}>
        <polyline className="k-pitch__line" points={moraPoints} fill="none" />
        <line className="k-pitch__line k-pitch__line--particle" x1={xs[n - 1]} y1={ys[n - 1]} x2={xs[n]} y2={ys[n]} />
        {p > 0 && (
          <path
            className="k-pitch__drop"
            data-testid="pitch-downstep"
            d={`M ${(xs[p - 1] ?? PAD) + 4} ${Y_HIGH - 3} H ${(xs[p - 1] ?? PAD) + STEP / 2} V ${Y_HIGH + 6}`}
            fill="none"
          />
        )}
        {xs.slice(0, n).map((x, i) => (
          <circle key={i} className={cx('k-pitch__dot', levels[i] && 'is-high')} cx={x} cy={ys[i]} r={3.2} />
        ))}
        <circle className="k-pitch__dot k-pitch__dot--particle" cx={xs[n]} cy={ys[n]} r={3} />
        {morae.map((m, i) => (
          <text key={i} className="k-pitch__mora" x={xs[i]} y={LABEL_Y} textAnchor="middle">
            {m}
          </text>
        ))}
      </svg>
      <span className="k-pitch__num">[{group.position}]</span>
    </span>
  );
}

export interface PitchAccentBadgeProps {
  readonly pitches: readonly MergedPitchGroup[];
  /** Max contours shown (default 2). */
  readonly max?: number;
  readonly testId?: string;
  readonly className?: string;
}

export function PitchAccentBadge({ pitches, max = 2, testId = 'vocab-pitch-badge', className }: PitchAccentBadgeProps) {
  if (pitches.length === 0) return null;
  const shown = pitches.slice(0, max);
  return (
    <span className={cx('k-pitch', className)} data-testid={testId} title={[...new Set(pitches.flatMap((p) => p.sources))].join(', ')}>
      {shown.map((g, i) => (
        <PitchContour key={`${g.reading}-${g.position}-${i}`} group={g} />
      ))}
    </span>
  );
}

/** Short dictionary label for a frequency badge (`JPDB v2.2 …` → `JPDB`). */
export function freqDictLabel(title: string): string {
  if (/jpdb/i.test(title)) return 'JPDB';
  const stripped = title.replace(/[(（].*?[)）]/g, '').trim();
  return stripped.split(/\s+/)[0] || title;
}

/** `3851` → `#3,851`. */
export function formatRank(value: number): string {
  return `#${Math.round(value).toLocaleString('en-US')}`;
}

/**
 * One badge per dictionary: the kana-orthography (`㋕`) rank when the word is
 * written in kana in the sentence and such a row exists, otherwise the
 * regular rank.
 */
export function pickFrequencies(frequencies: readonly FrequencyBadge[], preferKana: boolean): FrequencyBadge[] {
  const byDict = new Map<string, FrequencyBadge[]>();
  for (const f of frequencies) {
    const list = byDict.get(f.dictId) ?? [];
    list.push(f);
    byDict.set(f.dictId, list);
  }
  const out: FrequencyBadge[] = [];
  for (const list of byDict.values()) {
    const kana = list.find((f) => f.kanaOnly);
    const regular = list.find((f) => !f.kanaOnly);
    const chosen = preferKana ? (kana ?? regular) : (regular ?? kana);
    if (chosen) out.push(chosen);
  }
  return out;
}

export interface FreqBadgeProps {
  readonly badge: FrequencyBadge;
  /** Kana spelling shown for kana-orthography (`㋕`) ranks. */
  readonly kanaLabel?: string | undefined;
  readonly testId?: string;
}

export function FreqBadge({ badge, kanaLabel, testId = 'vocab-freq-badge' }: FreqBadgeProps) {
  const t = useT();
  const label = freqDictLabel(badge.dictTitle);
  const rank = formatRank(badge.value);
  const kana = t('dict.kanaOrthography');
  const text = badge.kanaOnly ? (kanaLabel ? `[${label} ${kanaLabel}(${kana}) ${rank}]` : `[${label} ${kana} ${rank}]`) : `[${label} ${rank}]`;
  return (
    <span className={cx('k-freq', badge.kanaOnly && 'is-kana')} data-testid={testId} data-kana-only={badge.kanaOnly || undefined} title={`${badge.dictTitle} · ${badge.displayValue}`}>
      {text}
    </span>
  );
}
