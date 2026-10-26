/**
 * Mock anime fixtures: 2 series × 3 episodes with ASS-style tracks containing
 * ordinary dialogue, a sentence split over two cues (multi-cue merge demo),
 * per-character karaoke OP lyrics with `\pos` (merged in the transcript), a
 * duplicate outline layer, a `\move` sign and a `Comment:` line. All lines are
 * original sample text written for Kotori.
 */
import type { AnimeEpisode, AnimeSeries, AssMarkup, ParsedSubtitleTrack, SubtitleCue, SubtitleTrack } from '@kotori/core';

const BASE_TIME = Date.UTC(2026, 8, 20, 12);

const dialogueMarkup = (over: Partial<AssMarkup> = {}): AssMarkup => ({
  layer: 0,
  styleName: 'Default',
  hasMove: false,
  hasKaraoke: false,
  isDrawing: false,
  isComment: false,
  playResX: 1280,
  playResY: 720,
  ...over,
});

interface LineSpec {
  readonly at: number;
  readonly dur: number;
  readonly text: string;
  readonly actor?: string;
}

/** Builds cues in index order from dialogue lines plus the special ASS events. */
function buildAssCues(lines: readonly LineSpec[], opts: { readonly opLyrics: readonly string[]; readonly opStart: number }): SubtitleCue[] {
  type Draft = Omit<SubtitleCue, 'index'>;
  const drafts: Draft[] = [];

  // Per-character karaoke OP: each glyph is its own Dialogue with \pos; the
  // next lyric line fades in ~100 ms before the previous one fades out.
  let t = opts.opStart;
  opts.opLyrics.forEach((lyric) => {
    const chars = Array.from(lyric);
    const lineEnd = t + 600 + chars.length * 180 + 1500;
    chars.forEach((ch, k) => {
      const x = 461 + k * 30;
      const y = 672;
      drafts.push({
        startMs: t + k * 180,
        endMs: lineEnd,
        text: ch,
        rawText: `{\\an7\\pos(${x},${y})\\fad(250,250)}${ch}`,
        markup: dialogueMarkup({ styleName: 'OP-Kara', alignment: 7, posFraction: { xFraction: x / 1280, yFraction: y / 720 }, fade: { inMs: 250, outMs: 250 } }),
      });
    });
    t = lineEnd - 100;
  });

  // Sign with \move (typesetting, hidden from the transcript by default).
  drafts.push({
    startMs: opts.opStart + 500,
    endMs: opts.opStart + 4500,
    text: '第一話',
    rawText: '{\\an5\\move(640,200,640,260)\\fad(300,300)}第一話',
    markup: dialogueMarkup({ styleName: 'Sign', alignment: 5, hasMove: true, fade: { inMs: 300, outMs: 300 } }),
  });
  // Translator comment (never displayed).
  drafts.push({
    startMs: 0,
    endMs: 1000,
    text: 'TL note: timing v2',
    rawText: 'TL note: timing v2',
    markup: dialogueMarkup({ isComment: true }),
  });

  for (const line of lines) {
    const markup = dialogueMarkup(line.actor ? { actor: line.actor } : {});
    drafts.push({ startMs: line.at, endMs: line.at + line.dur, text: line.text, rawText: line.text, markup });
    // Outline layer duplicate for one line (same start + text ⇒ de-duplicated).
    if (line.text === '行かなきゃ') {
      drafts.push({ startMs: line.at, endMs: line.at + line.dur, text: line.text, rawText: `{\\bord4}${line.text}`, markup: dialogueMarkup({ layer: 1 }) });
    }
  }
  drafts.sort((a, b) => a.startMs - b.startMs || (a.markup?.layer ?? 0) - (b.markup?.layer ?? 0));
  return drafts.map((d, index) => ({ ...d, index }));
}

const SERIES_A_LINES: readonly LineSpec[] = [
  { at: 32_000, dur: 2600, text: 'おはよう、ことり。今日も早いね。', actor: '湊' },
  { at: 35_000, dur: 2400, text: 'うん、朝の空気が好きなんだ。', actor: 'ことり' },
  { at: 38_000, dur: 2200, text: 'ちょっと待ってくれよ、', actor: '湊' },
  { at: 40_300, dur: 2600, text: 'まだ話は終わってないんだから。', actor: '湊' },
  { at: 43_500, dur: 2000, text: 'え、何の話だっけ？', actor: 'ことり' },
  { at: 46_000, dur: 2500, text: '昨日のケーキ、全部食べたでしょ。', actor: '湊' },
  { at: 49_000, dur: 1800, text: '食べてんじゃねぇよ！', actor: '湊' },
  { at: 51_200, dur: 2600, text: 'だって、すごくおいしかったんだもん。', actor: 'ことり' },
  { at: 54_500, dur: 2800, text: 'お前のことなんか、ぜんぜん気にしてねーし。', actor: '湊' },
  { at: 58_000, dur: 2400, text: 'ふふ、顔が赤いよ？', actor: 'ことり' },
  { at: 61_000, dur: 2000, text: 'うるさいな。', actor: '湊' },
  { at: 63_500, dur: 3000, text: 'ねえ、放課後いっしょに駅前の本屋に行かない？', actor: 'ことり' },
  { at: 67_000, dur: 2200, text: '別にいいけど、何を買うの？', actor: '湊' },
  { at: 69_800, dur: 2800, text: '新しい漫画が今日発売なんだって。', actor: 'ことり' },
  { at: 73_000, dur: 1600, text: 'あ、チャイムだ。', actor: '湊' },
  { at: 75_000, dur: 1500, text: '行かなきゃ', actor: 'ことり' },
  { at: 77_000, dur: 2600, text: '俺は絶対に諦めないからな', actor: '湊' },
  { at: 80_200, dur: 2600, text: '何を諦めないの？テストのこと？', actor: 'ことり' },
  { at: 83_400, dur: 2800, text: 'それは……秘密だ。', actor: '湊' },
  { at: 87_000, dur: 3200, text: '空がこんなに青いと、なんでもできる気がする。', actor: 'ことり' },
];

const SERIES_B_LINES: readonly LineSpec[] = [
  { at: 30_000, dur: 3000, text: 'こんばんは、星屑ラジオの時間です。', actor: 'DJ' },
  { at: 33_500, dur: 2800, text: '今夜も眠れないあなたに、とっておきの話を。', actor: 'DJ' },
  { at: 37_000, dur: 2600, text: '最初のお便りは、ペンネーム「夜更かし猫」さん。', actor: 'DJ' },
  { at: 40_200, dur: 3200, text: '最近、仕事が忙しくて全然寝てないんです。', actor: '猫' },
  { at: 44_000, dur: 2400, text: 'それは大変ですね。', actor: 'DJ' },
  { at: 47_000, dur: 2200, text: 'ちょっと待ってくれよ、', actor: '猫' },
  { at: 49_300, dur: 2600, text: 'まだ話は終わってないんだから。', actor: '猫' },
  { at: 52_500, dur: 2600, text: 'あ、すみません、どうぞ続けてください。', actor: 'DJ' },
  { at: 55_500, dur: 3000, text: '昨日なんて、気づいたら朝の五時でした。', actor: '猫' },
  { at: 59_000, dur: 2200, text: '体だけは大切にしてくださいね。', actor: 'DJ' },
  { at: 62_000, dur: 1500, text: '行かなきゃ', actor: '猫' },
  { at: 64_000, dur: 3000, text: 'では、ここで一曲お届けしましょう。', actor: 'DJ' },
  { at: 67_500, dur: 2800, text: '曲は「夜明けのメロディー」です。', actor: 'DJ' },
  { at: 71_000, dur: 2600, text: '俺は絶対に諦めないからな', actor: '少年' },
  { at: 74_200, dur: 3000, text: '星に願いを込めて、もう一度歩き出そう。', actor: 'DJ' },
];

const OP_A = ['手を伸ばして', '空へ駆け出そう'];
const OP_B = ['星屑の夜に', '君の声がする'];

interface SeriesFixture {
  readonly series: AnimeSeries;
  readonly episodes: AnimeEpisode[];
  readonly cuesByTrack: Map<string, ParsedSubtitleTrack>;
}

function srtTrackFromAss(cues: readonly SubtitleCue[]): ParsedSubtitleTrack {
  const zh: Record<string, string> = {
    'おはよう、ことり。今日も早いね。': '早啊，小鸟。今天也这么早。',
    '食べてんじゃねぇよ！': '别吃了啊！',
    '行かなきゃ': '我得走了。',
  };
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    const t = zh[c.text];
    if (t) out.push({ index: out.length, startMs: c.startMs, endMs: c.endMs, text: t, rawText: t });
  }
  return { info: { format: 'srt', encoding: 'utf-8', language: 'zh-CN' }, cues: out, warnings: [] };
}

function makeSeries(
  id: string,
  title: string,
  romaji: string,
  lines: readonly LineSpec[],
  op: readonly string[],
  episodeTitles: readonly string[],
  extra: Partial<AnimeSeries>,
): SeriesFixture {
  const cuesByTrack = new Map<string, ParsedSubtitleTrack>();
  const episodes: AnimeEpisode[] = episodeTitles.map((epTitle, i) => {
    const n = i + 1;
    const epId = `${id}-ep${n}`;
    const fileName = `[Kotori-Raws] ${romaji} - ${String(n).padStart(2, '0')} (1080p) [${(0xa1b2c3d4 + n).toString(16).toUpperCase()}].mkv`;
    // Shift lines slightly per episode so each feels distinct.
    const shifted = lines.map((l) => ({ ...l, at: l.at + i * 1500 }));
    const assCues = buildAssCues(shifted, { opLyrics: op, opStart: 4000 });
    const assTrackId = `${epId}-ja`;
    cuesByTrack.set(assTrackId, { info: { format: 'ass', encoding: 'utf-8', language: 'ja', title: `${title} 第${n}話`, styles: ['Default', 'OP-Kara', 'Sign'] }, cues: assCues, warnings: [] });
    const tracks: SubtitleTrack[] = [
      { id: assTrackId, episodeId: epId, origin: 'external', format: 'ass', label: '日本語 (ASS)', language: 'ja', filePath: `/anime/${romaji}/${fileName.replace(/\.mkv$/, '.ja.ass')}`, isDefault: true, cueCount: assCues.length, delayMs: 0 },
    ];
    if (n === 1) {
      const zhId = `${epId}-zh`;
      const srt = srtTrackFromAss(assCues);
      cuesByTrack.set(zhId, srt);
      tracks.push({ id: zhId, episodeId: epId, origin: 'jimaku', format: 'srt', label: '简体中文 (SRT)', language: 'zh-CN', filePath: `/kotori/subtitles/${epId}/zh.srt`, isDefault: false, cueCount: srt.cues.length, delayMs: 0 });
    }
    tracks.push({ id: `${epId}-emb2`, episodeId: epId, origin: 'embedded', format: 'ass', label: 'Embedded #2 (ass)', language: 'ja', streamIndex: 2, isDefault: false, delayMs: 0 });
    const durationMs = 23 * 60_000 + 40_000;
    return {
      id: epId,
      seriesId: id,
      title: epTitle,
      fileName,
      filePath: `/anime/${romaji}/${fileName}`,
      container: 'mkv',
      sizeBytes: 1_200_000_000 + n * 13_000_000,
      durationMs,
      parsedName: { raw: fileName, title: romaji, episode: n, releaseGroup: 'Kotori-Raws', resolution: '1080p', isBatch: false, crc32: (0xa1b2c3d4 + n).toString(16).toUpperCase() },
      subtitleTracks: tracks,
      ...(n === 1 ? { progress: { positionMs: 45_000, durationMs, updatedAt: BASE_TIME } } : {}),
      mediaUrl: `mock://media/${epId}`,
    };
  });
  return {
    series: {
      id,
      title,
      sourcePath: `/anime/${romaji}`,
      coverUrl: coverSvg(title, id === 'series-kotori' ? '#8ab49a' : '#7d8fc9'),
      episodeCount: episodes.length,
      addedAt: BASE_TIME,
      ...extra,
    },
    episodes,
    cuesByTrack,
  };
}

/** Minimal poster art as an SVG data URL (no binary assets in the repo). */
export function coverSvg(title: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#1d2420"/></linearGradient></defs><rect width="300" height="420" fill="url(#g)"/><circle cx="220" cy="110" r="58" fill="#ffffff" opacity=".18"/><circle cx="80" cy="330" r="90" fill="#000" opacity=".12"/><text x="150" y="250" font-family="'Noto Sans JP',sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml(title)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);
}

export function createAnimeFixtures(): SeriesFixture[] {
  return [
    makeSeries('series-kotori', 'ことりの約束', 'Kotori no Yakusoku', SERIES_A_LINES, OP_A, ['はじまりの朝', '放課後の本屋', '秘密の約束'], {
      lastWatchedEpisodeId: 'series-kotori-ep1',
      lastWatchedAt: BASE_TIME,
      jimakuEntryId: 4242,
      anilistId: 170000,
    }),
    makeSeries('series-hoshikuzu', '星屑ラジオ', 'Hoshikuzu Radio', SERIES_B_LINES, OP_B, ['眠れない夜に', '夜明けのメロディー', '最後のお便り'], { anilistId: 170001 }),
  ];
}
