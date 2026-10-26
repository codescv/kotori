import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeFileName, SubtitleStore } from './subtitle-store';

describe('sanitizeFileName', () => {
  it.each([
    ['Show - 01.ja.ass', 'Show - 01.ja.ass'],
    ['日本語字幕 第1話.srt', '日本語字幕 第1話.srt'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\sub.ass', 'sub.ass'],
    ['a:b?c*d<e>f|g"h.srt', 'a_b_c_d_e_f_g_h.srt'],
    ['tab\there\u0001.vtt', 'tab_here_.vtt'],
    ['.hidden.srt', '_hidden.srt'],
    ['...', '_'],
    ['  padded.srt  ', 'padded.srt'],
    ['', 'subtitle'],
    ['dir/', 'dir'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('caps the name at 200 UTF-8 bytes and keeps the extension', () => {
    const name = sanitizeFileName(`${'あ'.repeat(300)}.srt`);
    expect(name.endsWith('.srt')).toBe(true);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
    expect(name).toBe(`${'あ'.repeat(65)}.srt`);
    expect(sanitizeFileName(`${'a'.repeat(300)}.ass`)).toBe(`${'a'.repeat(196)}.ass`);
  });
});

describe('SubtitleStore', () => {
  let dataDir: string;
  let store: SubtitleStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kotori-subs-'));
    store = new SubtitleStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('roots files under {dataDir}/subtitles/{episodeId}', () => {
    expect(store.root).toBe(join(dataDir, 'subtitles'));
    expect(store.dirFor('ep-1')).toBe(join(dataDir, 'subtitles', 'ep-1'));
    // Episode ids are sanitised too, so they cannot escape the root.
    expect(store.dirFor('../../escape')).toBe(join(dataDir, 'subtitles', 'escape'));
  });

  it('writes text and bytes with sanitised names', async () => {
    const textPath = await store.writeText('ep-1', '../evil:name.srt', '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n');
    expect(textPath).toBe(join(store.dirFor('ep-1'), 'evil_name.srt'));
    expect(await readFile(textPath, 'utf8')).toContain('こんにちは');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    const bytesPath = await store.writeBytes('ep-1', 'b.ass', bytes);
    expect(new Uint8Array(await readFile(bytesPath))).toEqual(bytes);
    expect((await readdir(store.dirFor('ep-1'))).sort()).toEqual(['b.ass', 'evil_name.srt']);
    // Overwrites in place.
    await store.writeText('ep-1', 'b.ass', 'new');
    expect(await readFile(bytesPath, 'utf8')).toBe('new');
  });

  it('copies external files in (defaulting to the source name) and tolerates copying onto itself', async () => {
    const src = join(dataDir, 'outside.ja.srt');
    await writeFile(src, 'external');
    const copied = await store.copyFrom('ep-2', src);
    expect(copied).toBe(join(store.dirFor('ep-2'), 'outside.ja.srt'));
    expect(await readFile(copied, 'utf8')).toBe('external');
    const renamed = await store.copyFrom('ep-2', src, 'renamed?.srt');
    expect(renamed).toBe(join(store.dirFor('ep-2'), 'renamed_.srt'));
    await expect(store.copyFrom('ep-2', copied)).resolves.toBe(copied);
    expect(await readFile(copied, 'utf8')).toBe('external');
  });

  it('allocates a path (creating the directory but not the file)', async () => {
    const target = await store.allocate('ep-3', 'track 2.ass');
    expect(target).toBe(join(store.dirFor('ep-3'), 'track 2.ass'));
    expect(existsSync(store.dirFor('ep-3'))).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('knows which paths are managed', () => {
    expect(store.isManaged(join(store.root, 'ep', 'a.srt'))).toBe(true);
    expect(store.isManaged(join(store.root, 'ep', '..', '..', 'x.srt'))).toBe(false);
    expect(store.isManaged(store.root)).toBe(false);
    expect(store.isManaged(`${store.root}-other/a.srt`)).toBe(false);
    expect(store.isManaged(join(dataDir, 'a.srt'))).toBe(false);
  });

  it('removes only managed files', async () => {
    const managed = await store.writeText('ep-4', 'a.srt', 'x');
    const outside = join(dataDir, 'keep.srt');
    await writeFile(outside, 'keep');
    await store.removeFile(outside);
    expect(existsSync(outside)).toBe(true);
    await store.removeFile(managed);
    expect(existsSync(managed)).toBe(false);
    await expect(store.removeFile(managed)).resolves.toBeUndefined();
  });

  it('removes a whole episode directory (idempotently)', async () => {
    await store.writeText('ep-5', 'a.srt', 'x');
    await store.writeText('ep-5', 'b.srt', 'y');
    await store.removeEpisode('ep-5');
    expect(existsSync(store.dirFor('ep-5'))).toBe(false);
    await expect(store.removeEpisode('ep-5')).resolves.toBeUndefined();
  });
});
