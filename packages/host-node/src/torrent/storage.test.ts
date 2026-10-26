import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTorrentFile, parseTorrentFile } from './metainfo';
import type { TorrentMeta } from './metainfo';
import { filePieceRange, mapRange, pieceLengthAt, Storage } from './storage';

function payload(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

const PL = 16384;
const A = payload(20_000, 1); // file 0: [0, 20000)
const B = payload(5, 2); //      file 1: [20000, 20005)  — inside piece 1
const E = new Uint8Array(0); //  file 2: empty
const C = payload(30_000, 3); // file 3: [20005, 50005)
const ALL = new Uint8Array([...A, ...B, ...C]);

function makeMeta(): TorrentMeta {
  return parseTorrentFile(
    createTorrentFile({
      name: 'pack',
      pieceLength: PL,
      files: [
        { path: 'a.mkv', data: A },
        { path: 'b.txt', data: B },
        { path: 'empty', data: E },
        { path: 'dir/c.bin', data: C },
      ],
    }),
  );
}

const pieceData = (i: number): Uint8Array => ALL.slice(i * PL, Math.min(ALL.length, (i + 1) * PL));

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kotori-storage-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('piece ↔ file mapping', () => {
  const meta = makeMeta();

  it('splits ranges across file boundaries and skips empty files', () => {
    expect(meta.pieces).toHaveLength(4);
    expect(pieceLengthAt(meta, 0)).toBe(PL);
    expect(pieceLengthAt(meta, 3)).toBe(50_005 - 3 * PL);
    // Piece 1 = [16384, 32768): tail of a, all of b, head of c.
    expect(mapRange(meta.files, PL, PL)).toEqual([
      { fileIndex: 0, fileOffset: PL, rangeOffset: 0, length: 20_000 - PL },
      { fileIndex: 1, fileOffset: 0, rangeOffset: 20_000 - PL, length: 5 },
      { fileIndex: 3, fileOffset: 0, rangeOffset: 20_005 - PL, length: 2 * PL - 20_005 },
    ]);
    // A block in the middle of a single file.
    expect(mapRange(meta.files, 40_000, 100)).toEqual([{ fileIndex: 3, fileOffset: 40_000 - 20_005, rangeOffset: 0, length: 100 }]);
  });

  it('computes file piece ranges', () => {
    expect(filePieceRange(meta, meta.files[0]!)).toEqual({ start: 0, end: 2 });
    expect(filePieceRange(meta, meta.files[1]!)).toEqual({ start: 1, end: 2 });
    expect(filePieceRange(meta, meta.files[2]!)).toEqual({ start: 0, end: 0 });
    expect(filePieceRange(meta, meta.files[3]!)).toEqual({ start: 1, end: 4 });
  });
});

describe('Storage', () => {
  it('writes verified pieces into the right files and serves blocks back', async () => {
    const downloadDir = await tmp();
    const dataDir = await tmp();
    const meta = makeMeta();
    const s = new Storage(meta, { downloadDir, dataDir });
    await s.open([2]);
    expect(s.bitfield.count()).toBe(0);
    for (const i of [3, 1, 0, 2]) expect(await s.writePiece(i, pieceData(i))).toBe(true);
    expect(await s.readBlock(1, 3000, 1000)).toEqual(ALL.slice(PL + 3000, PL + 4000));
    await s.close();

    expect(new Uint8Array(await readFile(join(downloadDir, 'pack/a.mkv')))).toEqual(A);
    expect(new Uint8Array(await readFile(join(downloadDir, 'pack/b.txt')))).toEqual(B);
    expect((await stat(join(downloadDir, 'pack/empty'))).size).toBe(0);
    expect(new Uint8Array(await readFile(join(downloadDir, 'pack/dir/c.bin')))).toEqual(C);
  });

  it('rejects pieces that fail the hash check', async () => {
    const s = new Storage(makeMeta(), { downloadDir: await tmp(), dataDir: await tmp() });
    await s.open();
    const bad = pieceData(0);
    bad[10] = (bad[10] ?? 0) ^ 0xff;
    expect(await s.writePiece(0, bad)).toBe(false);
    expect(s.has(0)).toBe(false);
    await expect(s.readBlock(0, 0, 10)).rejects.toThrow();
    await s.close();
  });

  it('resumes from the bitfield file and tracks per-file progress', async () => {
    const downloadDir = await tmp();
    const dataDir = await tmp();
    const meta = makeMeta();
    const s1 = new Storage(meta, { downloadDir, dataDir });
    await s1.open();
    await s1.writePiece(1, pieceData(1));
    await s1.writePiece(3, pieceData(3));
    await s1.close();
    const bf = new Uint8Array(await readFile(join(dataDir, `${meta.infoHash}.bitfield`)));
    expect(bf).toEqual(new Uint8Array([0b0101_0000]));

    const s2 = new Storage(meta, { downloadDir, dataDir });
    await s2.open();
    expect([0, 1, 2, 3].map((i) => s2.has(i))).toEqual([false, true, false, true]);
    expect(s2.fileDownloaded(0)).toBe(20_000 - PL);
    expect(s2.fileDownloaded(1)).toBe(5);
    expect(s2.fileDownloaded(2)).toBe(0);
    expect(s2.fileDownloaded(3)).toBe(2 * PL - 20_005 + (50_005 - 3 * PL));
    await s2.close();
  });

  it('distrusts bitfield entries whose files vanished', async () => {
    const downloadDir = await tmp();
    const dataDir = await tmp();
    const meta = makeMeta();
    const s1 = new Storage(meta, { downloadDir, dataDir });
    await s1.open();
    await s1.writePiece(0, pieceData(0));
    await s1.writePiece(3, pieceData(3));
    await s1.close();
    await rm(join(downloadDir, 'pack/dir/c.bin'));
    const s2 = new Storage(meta, { downloadDir, dataDir });
    await s2.open();
    expect([s2.has(0), s2.has(3)]).toEqual([true, false]);
    await s2.close();
  });

  it('fully rechecks existing data when there is no bitfield', async () => {
    const downloadDir = await tmp();
    const dataDir = await tmp();
    await mkdir(join(downloadDir, 'pack/dir'), { recursive: true });
    await writeFile(join(downloadDir, 'pack/a.mkv'), A);
    await writeFile(join(downloadDir, 'pack/b.txt'), B);
    const corrupt = new Uint8Array(C);
    corrupt[29_500] = (corrupt[29_500] ?? 0) ^ 1; // inside piece 3 (c offsets ≥ 29147)
    await writeFile(join(downloadDir, 'pack/dir/c.bin'), corrupt);
    const meta = makeMeta();
    const s = new Storage(meta, { downloadDir, dataDir });
    await s.open();
    expect([0, 1, 2, 3].map((i) => s.has(i))).toEqual([true, true, true, false]);
    await s.close();
    // The recheck result is persisted for the next start.
    expect(new Uint8Array(await readFile(join(dataDir, `${meta.infoHash}.bitfield`)))).toEqual(new Uint8Array([0b1110_0000]));
  });

  it('deleteFiles removes payload, empty dirs and the resume file', async () => {
    const downloadDir = await tmp();
    const dataDir = await tmp();
    const meta = makeMeta();
    const s = new Storage(meta, { downloadDir, dataDir });
    await s.open([2]);
    for (let i = 0; i < 4; i++) await s.writePiece(i, pieceData(i));
    await s.flushBitfield();
    await s.deleteFiles();
    await expect(stat(join(downloadDir, 'pack'))).rejects.toThrow();
    await expect(stat(join(dataDir, `${meta.infoHash}.bitfield`))).rejects.toThrow();
  });
});
