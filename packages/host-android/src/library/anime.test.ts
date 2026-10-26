import { afterEach, describe, expect, it } from 'vitest';
import type { HostEvent } from '@kotori/core';
import { createTestHost, type TestHost } from '../testing/harness';
import { fixtureBytes } from '../testing/fixtures';

const open: TestHost[] = [];
async function makeHost(): Promise<TestHost> {
  const t = await createTestHost();
  open.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.host.dispose()));
});

const ROOT = 'file:///storage/emulated/0/Anime/Frieren';
const video = (name: string): string => `${ROOT}/${name}`;

async function seedSeries(t: TestHost): Promise<void> {
  const fake = new Uint8Array(1024);
  await t.fs.writeFile(video('[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv'), fake);
  await t.fs.writeFile(video('[SubsPlease] Sousou no Frieren - 02 (1080p) [BCDE2345].mkv'), fake);
  await t.fs.writeFile(video('[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].en.srt'), fixtureBytes('subs/sample.srt'));
  await t.fs.writeFile(video('[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].ja.ass'), fixtureBytes('subs/sample.ja.ass'));
  // Unprefixed sidecar matched by episode number.
  await t.fs.writeFile(video('Frieren_02.ja.srt'), fixtureBytes('subs/sample.srt'));
  await t.fs.writeFile(video('notes.txt'), new Uint8Array([1]));
}

describe('anime library', () => {
  it('imports a folder: episodes, sidecar tracks (ja default), mediaUrl via convertFileSrc', async () => {
    const t = await makeHost();
    await seedSeries(t);
    const events: HostEvent[] = [];
    t.host.subscribe((e) => events.push(e));
    const series = await t.host.anime.importSeries({ path: ROOT });
    expect(series).toMatchObject({ title: 'Sousou no Frieren', sourcePath: ROOT, episodeCount: 2 });
    expect(events).toContainEqual({ type: 'library-changed', scope: 'anime' });
    expect(await t.host.anime.listSeries()).toHaveLength(1);

    const episodes = await t.host.anime.listEpisodes(series.id);
    expect(episodes.map((e) => e.parsedName.episode)).toEqual([1, 2]);
    const [ep1, ep2] = episodes;
    expect(ep1?.container).toBe('mkv');
    expect(ep1?.mediaUrl).toBe('https://localhost/_capacitor_file_/storage/emulated/0/Anime/Frieren/[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv');
    expect(ep1?.subtitleTracks).toHaveLength(2);
    const def = ep1?.subtitleTracks.find((tr) => tr.isDefault);
    expect(def).toMatchObject({ language: 'ja', format: 'ass', origin: 'external' });
    expect(ep2?.subtitleTracks).toHaveLength(1);
    expect(ep2?.subtitleTracks[0]).toMatchObject({ language: 'ja', format: 'srt', isDefault: true });

    // Re-import of the same path is idempotent (same id).
    const again = await t.host.anime.importSeries({ path: ROOT });
    expect(again.id).toBe(series.id);
  });

  it('getCues parses once and applies the track delay', async () => {
    const t = await makeHost();
    await seedSeries(t);
    const series = await t.host.anime.importSeries({ path: ROOT });
    const [ep1] = await t.host.anime.listEpisodes(series.id);
    const track = ep1?.subtitleTracks.find((tr) => tr.format === 'ass');
    if (!track) throw new Error('missing ass track');
    const parsed = await t.host.anime.getCues(track.id);
    expect(parsed.info.format).toBe('ass');
    expect(parsed.cues[0]).toMatchObject({ startMs: 1000, endMs: 3500, text: '食べてんじゃねぇよ' });
    expect(parsed.cues[1]?.text).toBe('おい、\nちょっと待て');
    expect(parsed.cues[2]?.markup?.posFraction?.xFraction).toBeCloseTo(461 / 1920);
    expect(parsed.cues[3]?.markup?.isComment).toBe(true);
    expect(parsed.cues[4]?.markup?.isDrawing).toBe(true);

    const delayed = await t.host.anime.setTrackDelay(track.id, 1500);
    expect(delayed.delayMs).toBe(1500);
    const shifted = await t.host.anime.getCues(track.id);
    expect(shifted.cues[0]).toMatchObject({ startMs: 2500, endMs: 5000 });
    const negative = await t.host.anime.setTrackDelay(track.id, -2000);
    expect(negative.delayMs).toBe(-2000);
    expect((await t.host.anime.getCues(track.id)).cues[0]).toMatchObject({ startMs: 0, endMs: 1500 });
    expect((await t.host.anime.getEpisode(ep1?.id ?? '')).subtitleTracks.find((tr) => tr.id === track.id)?.cueCount).toBe(5);
  });

  it('addSubtitleTrack stores content under subtitles/{episodeId} and can be removed', async () => {
    const t = await makeHost();
    await seedSeries(t);
    const series = await t.host.anime.importSeries({ path: ROOT });
    const [, ep2] = await t.host.anime.listEpisodes(series.id);
    if (!ep2) throw new Error('missing ep2');
    const added = await t.host.anime.addSubtitleTrack(ep2.id, {
      fileName: 'mine.vtt',
      content: 'WEBVTT\n\n00:00.500 --> 00:01.000\n<ruby>字<rt>じ</rt></ruby>幕\n',
      language: 'ja',
    });
    expect(added).toMatchObject({ origin: 'imported', format: 'vtt', language: 'ja', isDefault: false, cueCount: 1, delayMs: 0 });
    expect(added.filePath).toBe(`${t.deps.dataRoot}/subtitles/${ep2.id}/mine.vtt`);
    const cues = await t.host.anime.getCues(added.id);
    expect(cues.cues[0]).toMatchObject({ startMs: 500, endMs: 1000, text: '字幕' });

    await t.host.anime.setDefaultTrack(ep2.id, added.id);
    let episode = await t.host.anime.getEpisode(ep2.id);
    expect(episode.subtitleTracks.filter((tr) => tr.isDefault).map((tr) => tr.id)).toEqual([added.id]);

    await t.host.anime.removeSubtitleTrack(added.id);
    episode = await t.host.anime.getEpisode(ep2.id);
    expect(episode.subtitleTracks).toHaveLength(1);
    expect(episode.subtitleTracks[0]?.isDefault).toBe(true);
    expect(await t.fs.stat(added.filePath ?? '')).toBeUndefined();

    await expect(t.host.anime.addSubtitleTrack(ep2.id, { fileName: 'bad.srt', content: 'nothing here' })).rejects.toMatchObject({ code: 'parse' });
    await expect(t.host.anime.addSubtitleTrack(ep2.id, { fileName: 'x.srt' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rescan picks up new episodes, keeps progress and imported tracks', async () => {
    const t = await makeHost();
    await seedSeries(t);
    const series = await t.host.anime.importSeries({ path: ROOT, titleOverride: 'フリーレン' });
    const [ep1] = await t.host.anime.listEpisodes(series.id);
    if (!ep1) throw new Error('missing ep1');
    await t.host.anime.saveProgress(ep1.id, { positionMs: 1234, durationMs: 1_440_000, updatedAt: 42 });
    await t.host.anime.addSubtitleTrack(ep1.id, { fileName: 'x.srt', content: '1\n00:00:01,000 --> 00:00:02,000\nhi\n' });
    await t.fs.writeFile(video('[SubsPlease] Sousou no Frieren - 03 (1080p) [CDEF3456].mkv'), new Uint8Array(10));
    const rescanned = await t.host.anime.rescanSeries(series.id);
    expect(rescanned).toMatchObject({ title: 'フリーレン', episodeCount: 3, lastWatchedEpisodeId: ep1.id, lastWatchedAt: 42 });
    const episode = await t.host.anime.getEpisode(ep1.id);
    expect(episode.progress).toEqual({ positionMs: 1234, durationMs: 1_440_000, updatedAt: 42 });
    expect(episode.subtitleTracks).toHaveLength(3);
  });

  it('imports a single video file and removes a series', async () => {
    const t = await makeHost();
    await seedSeries(t);
    const single = await t.host.anime.importSeries({ path: video('[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv') });
    expect(single.episodeCount).toBe(1);
    const [ep] = await t.host.anime.listEpisodes(single.id);
    expect(ep?.subtitleTracks).toHaveLength(2);
    await t.host.anime.removeSeries(single.id);
    expect(await t.host.anime.listSeries()).toEqual([]);
    expect(await t.fs.stat(video('[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv'))).toBeDefined();
    await expect(t.host.anime.importSeries({ path: `${ROOT}/missing` })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('autoFetchJimaku requires an API key', async () => {
    const t = await makeHost();
    await seedSeries(t);
    const series = await t.host.anime.importSeries({ path: ROOT });
    await expect(t.host.anime.autoFetchJimaku(series.id)).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
