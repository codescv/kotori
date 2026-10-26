/**
 * Mock manga fixtures: a 10-page `.mokuro` volume (vertical Japanese bubbles
 * with `linesCoords`, a cover, and one wide double-page spread) and a 6-page
 * raw volume (bubbles drawn but no OCR → VLM crop-to-explain). Page art is
 * generated SVG whose glyph positions match the OCR geometry exactly.
 */
import type { MangaBlock, MangaPage, MangaPoint, MangaRect, MangaVolume } from '@kotori/core';
import { coverSvg, escapeXml } from './anime';

const BASE_TIME = Date.UTC(2026, 8, 22, 9);
const PAGE_W = 1200;
const PAGE_H = 1700;

export interface BubbleSpec {
  /** Right edge x and top y of the text column group (vertical text). */
  readonly x: number;
  readonly y: number;
  readonly lines: readonly string[];
  readonly fontSize?: number;
  readonly speaker?: string;
  readonly translation?: string;
}

interface PageSpec {
  readonly width?: number;
  readonly height?: number;
  readonly bubbles: readonly BubbleSpec[];
  readonly panels?: readonly MangaRect[];
  readonly cover?: string;
}

/** Geometry of a vertical bubble: columns right→left, glyphs top→bottom. */
export function bubbleGeometry(b: BubbleSpec): { rect: MangaRect; linesCoords: MangaPoint[][]; fontSize: number; step: number; colW: number } {
  const fontSize = b.fontSize ?? 34;
  const step = Math.round(fontSize * 1.1);
  const colW = Math.round(fontSize * 1.3);
  const linesCoords: MangaPoint[][] = b.lines.map((line, li) => {
    const right = b.x - li * colW;
    const left = right - colW;
    const bottom = b.y + Array.from(line).length * step;
    return [
      [left, b.y],
      [right, b.y],
      [right, bottom],
      [left, bottom],
    ];
  });
  const maxLen = Math.max(...b.lines.map((l) => Array.from(l).length));
  const rect: MangaRect = { left: b.x - b.lines.length * colW, top: b.y, right: b.x, bottom: b.y + maxLen * step };
  return { rect, linesCoords, fontSize, step, colW };
}

function bubbleSvg(b: BubbleSpec): string {
  const g = bubbleGeometry(b);
  const cx = (g.rect.left + g.rect.right) / 2;
  const cy = (g.rect.top + g.rect.bottom) / 2;
  const rx = (g.rect.right - g.rect.left) / 2 + 46;
  const ry = (g.rect.bottom - g.rect.top) / 2 + 46;
  let glyphs = '';
  b.lines.forEach((line, li) => {
    const colCx = b.x - li * g.colW - g.colW / 2;
    Array.from(line).forEach((ch, ci) => {
      const y = b.y + ci * g.step + g.fontSize * 0.88;
      // Rotate long-vowel / dashes for vertical writing.
      const rot = /[ー〜～…―]/u.test(ch) ? ` transform="rotate(90 ${colCx} ${y - g.fontSize * 0.35})"` : '';
      glyphs += `<text x="${colCx}" y="${y}" font-size="${g.fontSize}" text-anchor="middle"${rot}>${escapeXml(ch)}</text>`;
    });
  });
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" stroke="#111" stroke-width="4"/><path d="M${cx - 20} ${cy + ry - 6} L${cx - 60} ${cy + ry + 60} L${cx + 14} ${cy + ry - 4}Z" fill="#fff" stroke="#111" stroke-width="4" stroke-linejoin="round"/><g font-family="'Noto Sans JP','Hiragino Mincho ProN',serif" fill="#111">${glyphs}</g>`;
}

function pageSvg(spec: PageSpec, pageNo: number, tint: string): string {
  const w = spec.width ?? PAGE_W;
  const h = spec.height ?? PAGE_H;
  if (spec.cover) return decodeURIComponent(coverSvg(spec.cover, tint).split(',')[1] ?? '').replace('width="300" height="420"', `width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"`);
  const panels = spec.panels ?? [
    { left: 40, top: 40, right: w - 40, bottom: h * 0.42 },
    { left: 40, top: h * 0.42 + 24, right: w * 0.5 - 12, bottom: h - 40 },
    { left: w * 0.5 + 12, top: h * 0.42 + 24, right: w - 40, bottom: h - 40 },
  ];
  const panelSvg = panels
    .map((p, i) => {
      const pcx = (p.left + p.right) / 2;
      const pcy = (p.top + p.bottom) / 2;
      return `<rect x="${p.left}" y="${p.top}" width="${p.right - p.left}" height="${p.bottom - p.top}" fill="#fafafa" stroke="#111" stroke-width="6"/><circle cx="${pcx + (i % 2 ? -80 : 90)}" cy="${pcy + 60}" r="${Math.min(p.right - p.left, p.bottom - p.top) / 5}" fill="${tint}" opacity=".35"/><path d="M${p.left + 30} ${p.bottom - 40} Q ${pcx} ${pcy + 120} ${p.right - 30} ${p.bottom - 60}" stroke="#999" stroke-width="3" fill="none"/>`;
    })
    .join('');
  const bubbles = spec.bubbles.map(bubbleSvg).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${panelSvg}${bubbles}<text x="${w / 2}" y="${h - 12}" font-size="22" text-anchor="middle" fill="#888">${pageNo}</text></svg>`;
}

const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function blocksFor(spec: PageSpec): MangaBlock[] {
  return spec.bubbles.map((b, index) => {
    const g = bubbleGeometry(b);
    return {
      index,
      rect: g.rect,
      vertical: true,
      fontSize: g.fontSize,
      zIndex: index,
      lines: b.lines,
      text: b.lines.join(''),
      linesCoords: g.linesCoords,
      source: 'mokuro',
      confidence: 0.97,
    };
  });
}

const MOKURO_PAGES: readonly PageSpec[] = [
  { cover: '放課後ノート 第1巻', bubbles: [] },
  {
    bubbles: [
      { x: 1080, y: 120, lines: ['おはよう、', 'ことり。'], speaker: '湊', translation: '早啊，小鸟。' },
      { x: 420, y: 160, lines: ['今日も', '早いね。'], speaker: '湊', translation: '今天也这么早呢。' },
      { x: 520, y: 900, lines: ['朝の空気が', '好きなんだ。'], speaker: 'ことり', translation: '我喜欢早晨的空气。' },
    ],
  },
  {
    bubbles: [
      { x: 1060, y: 110, lines: ['ちょっと', '待ってくれよ、'], speaker: '湊', translation: '等一下嘛，' },
      { x: 500, y: 140, lines: ['まだ話は', '終わってない', 'んだから。'], speaker: '湊', translation: '我话还没说完呢。' },
      { x: 1000, y: 880, lines: ['え、何の', '話だっけ？'], speaker: 'ことり', translation: '诶，说什么来着？' },
    ],
  },
  {
    bubbles: [
      { x: 1050, y: 120, lines: ['食べてん', 'じゃねぇよ！'], fontSize: 40, speaker: '湊', translation: '别吃了啊！' },
      { x: 480, y: 940, lines: ['だって', 'おいし', 'かったんだもん。'], speaker: 'ことり', translation: '因为太好吃了嘛。' },
    ],
  },
  {
    bubbles: [
      { x: 1080, y: 110, lines: ['お前のこと', 'なんか、', 'ぜんぜん', '気にしてねーし。'], speaker: '湊', translation: '我才一点都不在意你呢。' },
      { x: 420, y: 960, lines: ['ふふ、', '顔が赤いよ？'], speaker: 'ことり', translation: '呵呵，脸红了哦？' },
    ],
  },
  {
    width: 2400,
    height: 1700,
    panels: [{ left: 40, top: 40, right: 2360, bottom: 1660 }],
    bubbles: [{ x: 1900, y: 220, lines: ['俺は絶対に', '諦めないからな'], fontSize: 48, speaker: '湊', translation: '我是绝对不会放弃的！' }],
  },
  {
    bubbles: [
      { x: 1060, y: 120, lines: ['あ、', 'チャイムだ。'], speaker: '湊', translation: '啊，上课铃响了。' },
      { x: 520, y: 900, lines: ['行かなきゃ'], fontSize: 40, speaker: 'ことり', translation: '我得走了。' },
    ],
  },
  {
    bubbles: [
      { x: 1080, y: 130, lines: ['放課後、', '本屋に', '行かない？'], speaker: 'ことり', translation: '放学后去书店吗？' },
      { x: 480, y: 920, lines: ['別に', 'いいけど。'], speaker: '湊', translation: '倒也可以。' },
    ],
  },
  {
    bubbles: [
      { x: 1040, y: 140, lines: ['新しい漫画が', '今日発売', 'なんだって。'], speaker: 'ことり', translation: '听说新漫画今天发售。' },
      { x: 460, y: 940, lines: ['それは……', '秘密だ。'], speaker: '湊', translation: '那是……秘密。' },
    ],
  },
  {
    bubbles: [{ x: 760, y: 500, lines: ['空がこんなに', '青いと、', 'なんでも', 'できる気がする。'], fontSize: 40, speaker: 'ことり', translation: '天空这么蓝，感觉什么都能做到。' }],
  },
];

const RAW_PAGES: readonly PageSpec[] = [
  { cover: '星屑ラジオ（原画）', bubbles: [] },
  {
    bubbles: [
      { x: 1060, y: 120, lines: ['こんばんは、', '星屑ラジオの', '時間です。'], speaker: 'DJ', translation: '晚上好，现在是星屑电台时间。' },
      { x: 480, y: 940, lines: ['今夜も', '眠れない', 'あなたに。'], speaker: 'DJ', translation: '献给今夜也无法入眠的你。' },
    ],
  },
  {
    bubbles: [
      { x: 1080, y: 130, lines: ['最近、仕事が', '忙しくて', '全然寝てない', 'んです。'], speaker: '猫', translation: '最近工作太忙，完全没睡。' },
      { x: 460, y: 960, lines: ['それは', '大変ですね。'], speaker: 'DJ', translation: '那可真辛苦。' },
    ],
  },
  {
    bubbles: [
      { x: 1050, y: 120, lines: ['行かなきゃ'], fontSize: 42, speaker: '猫', translation: '我得走了。' },
      { x: 500, y: 900, lines: ['体だけは', '大切に', 'してくださいね。'], speaker: 'DJ', translation: '请一定保重身体。' },
    ],
  },
  {
    bubbles: [{ x: 760, y: 420, lines: ['俺は絶対に', '諦めないからな'], fontSize: 46, speaker: '少年', translation: '我是绝对不会放弃的！' }],
  },
  {
    bubbles: [{ x: 800, y: 520, lines: ['星に願いを', '込めて、', 'もう一度', '歩き出そう。'], speaker: 'DJ', translation: '把愿望托付给星星，再一次迈步向前吧。' }],
  },
];

export interface MangaFixture {
  readonly volume: MangaVolume;
  readonly pages: MangaPage[];
  /** Ground truth bubbles per page (for mock OCR / page guide on raw volumes). */
  readonly truth: readonly (readonly BubbleSpec[])[];
}

function makeVolume(
  id: string,
  title: string,
  seriesTitle: string,
  kind: MangaVolume['kind'],
  specs: readonly PageSpec[],
  tint: string,
  extra: Partial<MangaVolume>,
): MangaFixture {
  const pages: MangaPage[] = specs.map((spec, index) => ({
    index,
    relativePath: `${title}/p${String(index + 1).padStart(3, '0')}.jpg`,
    width: spec.width ?? PAGE_W,
    height: spec.height ?? PAGE_H,
    blocks: kind === 'mokuro' ? blocksFor(spec) : [],
    imageUrl: svgUrl(pageSvg(spec, index + 1, tint)),
  }));
  return {
    volume: {
      id,
      title,
      seriesTitle,
      volumeNumber: 1,
      kind,
      sourcePath: kind === 'mokuro' ? `/manga/${title}.mokuro` : `/manga/${title}.cbz`,
      pageCount: pages.length,
      hasOcr: kind === 'mokuro',
      coverUrl: pages[0]?.imageUrl ?? '',
      coverIsSingle: true,
      addedAt: BASE_TIME,
      ...extra,
    },
    pages,
    truth: specs.map((s) => s.bubbles),
  };
}

export function createMangaFixtures(): MangaFixture[] {
  return [
    makeVolume('vol-houkago-1', '放課後ノート 第1巻', '放課後ノート', 'mokuro', MOKURO_PAGES, '#8ab49a', {
      progress: { pageIndex: 1, updatedAt: BASE_TIME },
    }),
    makeVolume('vol-hoshikuzu-raw-1', '星屑ラジオ 原画集', '星屑ラジオ', 'images', RAW_PAGES, '#7d8fc9', { readingMode: 'single-rtl' }),
  ];
}
