import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KotoriError, type HostEvent } from '@kotori/core';
import type { TorrentEngine } from '../../downloads/torrent-engine';
import { createServerContext, type ServerContext } from '../context';
import { createAnimeService } from './anime';

describe('NodeAnimeService — animeRoots folder detection, split consolidation & permanent removal', () => {
  let dir: string;
  let ctx: ServerContext;
  let events: HostEvent[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kotori-anime-svc-'));
    events = [];
    const fakeEngine: TorrentEngine = {
      add: async () => {
        throw new Error('torrent disabled');
      },
      get: () => undefined,
      remove: async () => undefined,
      destroy: async () => undefined,
    };
    ctx = await createServerContext(
      { host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), openBrowser: false },
      {
        fetch: async () => new Response('not found', { status: 404 }),
        ffmpeg: null,
        adc: async () => 'token',
        home: dir,
        torrentEngine: () => fakeEngine,
      },
    );
    ctx.events.subscribe((e) => events.push(e));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function makeNogiFolder(): Promise<{ nogiDir: string; files: string[] }> {
    const nogiDir = join(dir, 'Videos', 'NogiKouji');
    await mkdir(nogiDir, { recursive: true });
    const names = [
      '2026-08-16_【公式】「乃木坂工事中」# 577「夏休み目標発表会」2026.08.16 OA_[aaa111].mp4',
      '2026-08-23_【公式】「乃木坂工事中」# 578「初耳46 前編」2026.08.23 OA_[cEE5gee6cx4].mp4',
      '2026-08-30_【公式】「乃木坂工事中」# 579「初耳46 後編」2026.08.30 OA_[bbb222].mp4',
    ];
    const files: string[] = [];
    for (const name of names) {
      const fp = join(nogiDir, name);
      await writeFile(fp, new Uint8Array(512));
      files.push(fp);
    }
    return { nogiDir, files };
  }

  it('imports a configured series folder of .mp4 files as a single multi-episode series instead of splitting per file', async () => {
    const { nogiDir } = await makeNogiFolder();

    await ctx.host.settings.update({ library: { animeRoots: [nogiDir] } });
    const list = await ctx.host.anime.listSeries();

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      title: '乃木坂工事中',
      sourcePath: nogiDir,
      episodeCount: 3,
    });
    const episodes = await ctx.host.anime.listEpisodes(list[0]!.id);
    expect(episodes.map((e) => e.parsedName.episode)).toEqual([577, 578, 579]);
  });

  it('automatically consolidates previously split per-file series into a single folder series while preserving progress', async () => {
    const { nogiDir, files } = await makeNogiFolder();

    // Simulate legacy broken state: each video file was imported as its own standalone 1-episode series.
    const splitSeries = [];
    for (const fp of files) {
      splitSeries.push(await ctx.host.anime.importSeries({ path: fp }));
    }
    expect(await ctx.host.anime.listSeries()).toHaveLength(3);

    const firstSplitEps = await ctx.host.anime.listEpisodes(splitSeries[0]!.id);
    await ctx.host.anime.saveProgress(firstSplitEps[0]!.id, {
      positionMs: 42_000,
      durationMs: 1_500_000,
      updatedAt: 1_700_000_000_000,
    });

    // Adding nogiDir to animeRoots consolidates the 3 split series into 1 series with 3 episodes.
    await ctx.host.settings.update({ library: { animeRoots: [nogiDir] } });
    const afterConsolidation = await ctx.host.anime.listSeries();

    expect(afterConsolidation).toHaveLength(1);
    expect(afterConsolidation[0]).toMatchObject({
      title: '乃木坂工事中',
      sourcePath: nogiDir,
      episodeCount: 3,
    });
    const consolidatedEps = await ctx.host.anime.listEpisodes(afterConsolidation[0]!.id);
    expect(consolidatedEps).toHaveLength(3);
    expect(consolidatedEps[0]?.progress?.positionMs).toBe(42_000);
  });

  it('permanently removes a series without scanRoots/listSeries re-importing it, cleans matching animeRoots, and allows explicit re-import', async () => {
    const { nogiDir } = await makeNogiFolder();

    await ctx.host.settings.update({ library: { animeRoots: [nogiDir] } });
    const [imported] = await ctx.host.anime.listSeries();
    expect(imported).toBeDefined();

    await ctx.host.anime.removeSeries(imported!.id);

    // Matching animeRoots entry is removed and settings-changed is emitted.
    expect((await ctx.host.settings.get()).library.animeRoots).toEqual([]);
    expect(events.some((e) => e.type === 'settings-changed' && e.settings.library.animeRoots.length === 0)).toBe(true);

    // Neither listSeries() nor scanRoots([nogiDir]) re-imports the excluded path.
    expect(await ctx.host.anime.listSeries()).toEqual([]);
    await ctx.host.anime.scanRoots([nogiDir]);
    expect(await ctx.host.anime.listSeries()).toEqual([]);

    // Explicit importSeries on a child file inside an excluded folder still succeeds, and can also be removed cleanly.
    const { files: nogiFiles } = await makeNogiFolder();
    const childImported = await ctx.host.anime.importSeries({ path: nogiFiles[0]! });
    expect(childImported.episodeCount).toBe(1);
    await ctx.host.anime.removeSeries(childImported.id);
    expect(await ctx.host.anime.listSeries()).toEqual([]);

    // Re-adding nogiDir in settings.update unexcludes it and imports it cleanly again.
    await ctx.host.settings.update({ library: { animeRoots: [nogiDir] } });
    const reAdded = await ctx.host.anime.listSeries();
    expect(reAdded).toHaveLength(1);
    expect(reAdded[0]?.sourcePath).toBe(nogiDir);

    // Also verify child folder removal inside a multi-series parent root stays excluded while keeping sibling series.
    await ctx.host.anime.removeSeries(reAdded[0]!.id);
    const parentRoot = join(dir, 'AnimeLibrary');
    const showA = join(parentRoot, 'ShowA');
    const showB = join(parentRoot, 'ShowB');
    await mkdir(showA, { recursive: true });
    await mkdir(showB, { recursive: true });
    await writeFile(join(showA, '[Sub] ShowA - 01.mp4'), new Uint8Array(256));
    await writeFile(join(showB, '[Sub] ShowB - 01.mp4'), new Uint8Array(256));

    await ctx.host.settings.update({ library: { animeRoots: [parentRoot] } });
    const both = await ctx.host.anime.listSeries();
    expect(both.map((s) => s.title).sort()).toEqual(['ShowA', 'ShowB']);

    const targetA = both.find((s) => s.title === 'ShowA')!;
    await ctx.host.anime.removeSeries(targetA.id);

    // Parent root remains configured, ShowB stays, and ShowA is NOT re-imported by listSeries() / scanRoots().
    expect((await ctx.host.settings.get()).library.animeRoots).toEqual([parentRoot]);
    const remaining = await ctx.host.anime.listSeries();
    expect(remaining.map((s) => s.title)).toEqual(['ShowB']);

    // Explicit manual importSeries unexcludes ShowA.
    await ctx.host.anime.importSeries({ path: showA });
    expect((await ctx.host.anime.listSeries()).map((s) => s.title).sort()).toEqual(['ShowA', 'ShowB']);
  });

  it('never resurrects a removed series when removeSeries races against concurrent listSeries, scanRoots, listEpisodes, or SSE listeners', async () => {
    const { nogiDir } = await makeNogiFolder();

    // Simulate real SSE listeners (App + AnimePage) firing listSeries() on every anime library-changed event.
    const sseInflight: Promise<unknown>[] = [];
    const unsub = ctx.events.subscribe((e) => {
      if (e.type === 'library-changed' && e.scope === 'anime') {
        sseInflight.push(ctx.host.anime.listSeries());
        sseInflight.push(ctx.host.anime.listSeries());
      }
    });

    try {
      await ctx.host.settings.update({ library: { animeRoots: [nogiDir] } });
      await Promise.allSettled(sseInflight.splice(0));

      const [series] = await ctx.host.anime.listSeries();
      expect(series).toBeDefined();

      // Fire overlapping scanRoots, listSeries, listEpisodes, rescanSeries, and removeSeries concurrently.
      const p1 = ctx.host.anime.listSeries();
      const p2 = ctx.host.anime.scanRoots([nogiDir]);
      const p3 = ctx.host.anime.listEpisodes(series!.id).catch(() => []);
      const p4 = ctx.host.anime.rescanSeries(series!.id).catch(() => undefined);
      // Let scanAnimeFolder get mid-flight on the event loop before removeSeries runs.
      await new Promise((r) => setImmediate(r));
      const pRemove = ctx.host.anime.removeSeries(series!.id);
      const p5 = ctx.host.anime.listSeries();

      await Promise.allSettled([p1, p2, p3, p4, pRemove, p5]);
      await Promise.allSettled(sseInflight.splice(0));
      await ctx.host.anime.idle();

      expect(await ctx.host.anime.listSeries()).toEqual([]);
      expect((await ctx.host.settings.get()).library.animeRoots).toEqual([]);
    } finally {
      unsub();
    }
  });

  it('probeSeries breaks out of the episode loop immediately after a fatal spawn error (spawn Unknown system error -86)', async () => {
    const { nogiDir } = await makeNogiFolder();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ebadarchCause = Object.assign(new Error('spawn Unknown system error -86'), {
      code: 'Unknown system error -86',
      errno: -86,
      syscall: 'spawn /usr/local/bin/ffprobe',
    });
    const probeStreamsSpy = vi.fn(async () => {
      throw new KotoriError('io', `/usr/local/bin/ffprobe: ${ebadarchCause.message}`, { cause: ebadarchCause });
    });

    const anime = createAnimeService({
      db: ctx.db,
      repos: ctx.repos,
      settings: ctx.settings,
      subtitles: ctx.subtitles,
      emit: (e) => events.push(e),
      ffmpeg: () => ({ ffmpeg: '/usr/local/bin/ffmpeg', ffprobe: '/usr/local/bin/ffprobe' }),
      downloads: () => ctx.downloads,
      fetch: async () => new Response('not found', { status: 404 }),
      probeStreams: probeStreamsSpy,
    });

    const series = await anime.importSeries({ path: nogiDir });
    await anime.idle();

    expect(series.episodeCount).toBe(3);
    expect(probeStreamsSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[kotori:anime] ffprobe failed for');
    expect(warnSpy.mock.calls[0]?.[1]).toContain('spawn Unknown system error -86');
  });

  it('ensureDefaultTrack upgrades an untagged default sidecar when a preferred .ja.srt sidecar is synced', async () => {
    const showDir = join(dir, 'Videos', 'UntaggedUpgrade');
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, 'Show - 01.mp4'), new Uint8Array(256));
    const untaggedSrt = '1\n00:00:01,000 --> 00:00:02,500\n早啊，小鸟。\n';
    await writeFile(join(showDir, 'Show - 01.srt'), untaggedSrt, 'utf8');

    const series = await ctx.host.anime.importSeries({ path: showDir });
    const [epBefore] = await ctx.host.anime.listEpisodes(series.id);
    expect(epBefore?.subtitleTracks).toHaveLength(1);
    expect(epBefore?.subtitleTracks[0]?.language).toBeUndefined();
    expect(epBefore?.subtitleTracks[0]?.isDefault).toBe(true);

    // Sync a newly added Japanese sidecar (.ja.srt) → default upgrades from untagged to Japanese.
    const jaSrt = '1\n00:00:01,000 --> 00:00:02,500\nおはよう、ことり。\n';
    await writeFile(join(showDir, 'Show - 01.ja.srt'), jaSrt, 'utf8');

    const [epAfter] = await ctx.host.anime.listEpisodes(series.id);
    expect(epAfter?.subtitleTracks).toHaveLength(2);
    const defaultTrack = epAfter?.subtitleTracks.find((t) => t.isDefault);
    const untaggedTrack = epAfter?.subtitleTracks.find((t) => t.language === undefined);
    expect(defaultTrack?.language).toBe('ja');
    expect(untaggedTrack?.isDefault).toBe(false);
  });

  it('prefers .ja.vtt over .ja.srt/.ja.ass on import, upgrades .ja.srt default when a new .ja.vtt is synced, and respects manual override', async () => {
    const jaSrt = '1\n00:00:01,000 --> 00:00:02,500\n漢字を読む\n';
    const jaVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<ruby>漢字<rt>かんじ</rt></ruby>を<ruby>読<rt>よ</rt></ruby>む\n';
    const jaAss = '[Script Info]\nPlayResX: 1920\nPlayResY: 1080\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,漢字を読む\n';

    // 1. Fresh import with .ja.srt, .ja.ass, .ja.vtt, and .en.vtt → .ja.vtt wins default.
    const freshDir = join(dir, 'Videos', 'VttPriority');
    await mkdir(freshDir, { recursive: true });
    await writeFile(join(freshDir, 'Show - 01.mp4'), new Uint8Array(256));
    await writeFile(join(freshDir, 'Show - 01.ja.srt'), jaSrt, 'utf8');
    await writeFile(join(freshDir, 'Show - 01.ja.ass'), jaAss, 'utf8');
    await writeFile(join(freshDir, 'Show - 01.ja.vtt'), jaVtt, 'utf8');
    await writeFile(join(freshDir, 'Show - 01.en.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nRead kanji\n', 'utf8');

    const freshSeries = await ctx.host.anime.importSeries({ path: freshDir });
    const [freshEp] = await ctx.host.anime.listEpisodes(freshSeries.id);
    const freshDefault = freshEp?.subtitleTracks.find((t) => t.isDefault);
    expect(freshDefault).toMatchObject({ language: 'ja', format: 'vtt', origin: 'external' });

    // getCues on .ja.vtt parses ruby segments and preserves them with delayMs !== 0.
    const parsed = await ctx.host.anime.getCues(freshDefault!.id);
    expect(parsed.cues[0]?.text).toBe('漢字を読む');
    expect(parsed.cues[0]?.ruby).toEqual([
      { base: '漢字', ruby: 'かんじ', charSpan: [0, 2] },
      { base: '読', ruby: 'よ', charSpan: [3, 4] },
    ]);
    await ctx.host.anime.setTrackDelay(freshDefault!.id, 250);
    const delayed = await ctx.host.anime.getCues(freshDefault!.id);
    expect(delayed.cues[0]?.startMs).toBe(1250);
    expect(delayed.cues[0]?.ruby).toEqual(parsed.cues[0]?.ruby);

    // 2. Existing series with .ja.srt default → newly added .ja.vtt upgrades default automatically.
    const upgradeDir = join(dir, 'Videos', 'VttUpgrade');
    await mkdir(upgradeDir, { recursive: true });
    await writeFile(join(upgradeDir, 'Show - 01.mp4'), new Uint8Array(256));
    await writeFile(join(upgradeDir, 'Show - 01.ja.srt'), jaSrt, 'utf8');

    const upSeries = await ctx.host.anime.importSeries({ path: upgradeDir });
    const [epBefore] = await ctx.host.anime.listEpisodes(upSeries.id);
    const srtTrack = epBefore?.subtitleTracks.find((t) => t.format === 'srt');
    expect(srtTrack?.isDefault).toBe(true);

    await writeFile(join(upgradeDir, 'Show - 01.ja.vtt'), jaVtt, 'utf8');
    const [epUpgraded] = await ctx.host.anime.listEpisodes(upSeries.id);
    const vttTrack = epUpgraded?.subtitleTracks.find((t) => t.format === 'vtt');
    expect(vttTrack?.isDefault).toBe(true);
    expect(epUpgraded?.subtitleTracks.find((t) => t.id === srtTrack!.id)?.isDefault).toBe(false);

    // 3. User manually switches default back to .ja.srt → subsequent re-sync must NOT override it.
    await ctx.host.anime.setDefaultTrack(epUpgraded!.id, srtTrack!.id);
    await writeFile(join(upgradeDir, 'Show - 01.zh-CN.srt'), '1\n00:00:01,000 --> 00:00:02,500\n阅读汉字\n', 'utf8');
    const [epAfterManual] = await ctx.host.anime.listEpisodes(upSeries.id);
    expect(epAfterManual?.subtitleTracks.find((t) => t.isDefault)?.id).toBe(srtTrack!.id);

    // 4. Real NogiKouji sidecar matrix: .ja.vtt beats .ja.srt, .ja-proofread.srt, .ja-orig.srt, .srt while keeping .zh-CN.srt available.
    const nogiMatrixDir = join(dir, 'Videos', 'NogiKoujiMatrix');
    await mkdir(nogiMatrixDir, { recursive: true });
    const stem = '2026-11-22_【公式】「乃木坂工事中」# 591「揚げたらうまいもん選手権 後編」2026.11.22_[Jk--UkyfB7I]';
    await writeFile(join(nogiMatrixDir, `${stem}.mp4`), new Uint8Array(256));
    await writeFile(join(nogiMatrixDir, `${stem}.srt`), jaSrt, 'utf8');
    await writeFile(join(nogiMatrixDir, `${stem}.ja-orig.srt`), jaSrt, 'utf8');
    await writeFile(join(nogiMatrixDir, `${stem}.ja-proofread.srt`), jaSrt, 'utf8');
    await writeFile(join(nogiMatrixDir, `${stem}.ja.srt`), jaSrt, 'utf8');
    await writeFile(join(nogiMatrixDir, `${stem}.ja.vtt`), jaVtt, 'utf8');
    await writeFile(join(nogiMatrixDir, `${stem}.zh-CN.srt`), '1\n00:00:01,000 --> 00:00:02,500\n阅读汉字\n', 'utf8');

    const nogiSeries = await ctx.host.anime.importSeries({ path: nogiMatrixDir });
    const [nogiEp] = await ctx.host.anime.listEpisodes(nogiSeries.id);
    const nogiDef = nogiEp?.subtitleTracks.find((t) => t.isDefault);
    expect(nogiDef).toMatchObject({ language: 'ja', format: 'vtt', origin: 'external' });
    expect(nogiDef?.filePath).toBe(join(nogiMatrixDir, `${stem}.ja.vtt`));
    expect(nogiEp?.subtitleTracks.some((t) => t.language === 'zh-CN' && t.format === 'srt')).toBe(true);
  });
});
