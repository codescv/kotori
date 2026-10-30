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
});
