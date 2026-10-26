/**
 * Piece storage: multi-file piece ↔ file mapping, verified writes with fsync,
 * block reads for seeding, and resume via `{dataDir}/{infoHash}.bitfield`.
 */
import { mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { BitField } from './bitfield';
import { sha1 } from './metainfo';
import type { TorrentFileEntry, TorrentMeta } from './metainfo';

/** A contiguous slice of a piece (or block) that lives in one file. */
export interface FileSegment {
  readonly fileIndex: number;
  /** Offset inside the file. */
  readonly fileOffset: number;
  /** Offset inside the requested range. */
  readonly rangeOffset: number;
  readonly length: number;
}

/**
 * Maps a global payload range `[offset, offset+length)` onto file segments.
 * Zero-length files never produce segments.
 */
export function mapRange(files: readonly TorrentFileEntry[], offset: number, length: number): FileSegment[] {
  const out: FileSegment[] = [];
  const end = offset + length;
  for (const f of files) {
    const fEnd = f.offset + f.length;
    if (f.length === 0 || fEnd <= offset || f.offset >= end) continue;
    const start = Math.max(offset, f.offset);
    const stop = Math.min(end, fEnd);
    out.push({ fileIndex: f.index, fileOffset: start - f.offset, rangeOffset: start - offset, length: stop - start });
  }
  return out;
}

/** Length of piece `index`. */
export function pieceLengthAt(meta: Pick<TorrentMeta, 'length' | 'pieceLength'>, index: number): number {
  const last = Math.ceil(meta.length / meta.pieceLength) - 1;
  if (index < last) return meta.pieceLength;
  return meta.length - last * meta.pieceLength;
}

/** Inclusive-exclusive piece range `[start, end)` that covers file `f` (empty for zero-length files). */
export function filePieceRange(meta: Pick<TorrentMeta, 'pieceLength'>, f: TorrentFileEntry): { start: number; end: number } {
  if (f.length === 0) return { start: 0, end: 0 };
  return { start: Math.floor(f.offset / meta.pieceLength), end: Math.floor((f.offset + f.length - 1) / meta.pieceLength) + 1 };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface StorageOptions {
  /** Directory the torrent's file paths are relative to. */
  readonly downloadDir: string;
  /** Directory holding `{infoHash}.bitfield` resume files. */
  readonly dataDir: string;
}

/** Disk storage for one torrent. All methods are safe to call concurrently. */
export class Storage {
  readonly meta: TorrentMeta;
  readonly bitfield: BitField;
  private readonly opts: StorageOptions;
  private readonly handles = new Map<number, Promise<FileHandle>>();
  private bitfieldTimer: NodeJS.Timeout | undefined;
  private bitfieldWrite: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(meta: TorrentMeta, opts: StorageOptions) {
    this.meta = meta;
    this.opts = opts;
    this.bitfield = new BitField(meta.pieces.length);
  }

  get pieceCount(): number {
    return this.meta.pieces.length;
  }

  get bitfieldPath(): string {
    return join(this.opts.dataDir, `${this.meta.infoHash}.bitfield`);
  }

  filePath(fileIndex: number): string {
    const f = this.meta.files[fileIndex];
    if (!f) throw new Error(`no file ${fileIndex}`);
    return join(this.opts.downloadDir, ...f.path.split('/'));
  }

  pieceLength(index: number): number {
    return pieceLengthAt(this.meta, index);
  }

  segments(index: number, offset = 0, length = this.pieceLength(index) - offset): FileSegment[] {
    return mapRange(this.meta.files, index * this.meta.pieceLength + offset, length);
  }

  has(index: number): boolean {
    return this.bitfield.get(index);
  }

  /** Verified bytes of file `fileIndex` (sum of overlaps with verified pieces). */
  fileDownloaded(fileIndex: number): number {
    const f = this.meta.files[fileIndex];
    if (!f || f.length === 0) return 0;
    const { start, end } = filePieceRange(this.meta, f);
    let n = 0;
    for (let i = start; i < end; i++) {
      if (!this.bitfield.get(i)) continue;
      const pStart = i * this.meta.pieceLength;
      const pEnd = pStart + this.pieceLength(i);
      n += Math.min(pEnd, f.offset + f.length) - Math.max(pStart, f.offset);
    }
    return n;
  }

  /**
   * Loads resume state. With a valid bitfield file its pieces are trusted
   * (after a cheap file-size sanity check); otherwise every piece whose files
   * exist is re-hashed. Also creates zero-length files in `createEmpty`.
   */
  async open(createEmpty: readonly number[] = []): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    for (const idx of createEmpty) {
      const f = this.meta.files[idx];
      if (f && f.length === 0) {
        const p = this.filePath(idx);
        await mkdir(dirname(p), { recursive: true });
        await (await open(p, fsConstants.O_RDWR | fsConstants.O_CREAT)).close();
      }
    }
    const sizes = await this.fileSizes();
    let resume: Uint8Array | undefined;
    try {
      resume = new Uint8Array(await readFile(this.bitfieldPath));
    } catch {
      resume = undefined;
    }
    if (resume && resume.length === Math.ceil(this.pieceCount / 8)) {
      const loaded = new BitField(this.pieceCount, resume);
      for (let i = 0; i < this.pieceCount; i++) {
        if (loaded.get(i) && this.segments(i).every((s) => (sizes[s.fileIndex] ?? -1) >= s.fileOffset + s.length)) {
          this.bitfield.set(i);
        }
      }
      return;
    }
    await this.recheck(sizes);
    this.scheduleBitfieldWrite(0);
  }

  private async fileSizes(): Promise<number[]> {
    return Promise.all(
      this.meta.files.map(async (f) => {
        try {
          return (await stat(this.filePath(f.index))).size;
        } catch {
          return -1;
        }
      }),
    );
  }

  /** Re-hashes every piece whose bytes are present on disk. */
  async recheck(sizes?: number[]): Promise<void> {
    const sz = sizes ?? (await this.fileSizes());
    const readers = new Map<number, FileHandle>();
    try {
      for (let i = 0; i < this.pieceCount; i++) {
        const segs = this.segments(i);
        if (!segs.every((s) => (sz[s.fileIndex] ?? -1) >= s.fileOffset + s.length)) {
          this.bitfield.set(i, false);
          continue;
        }
        const buf = new Uint8Array(this.pieceLength(i));
        for (const s of segs) {
          let fh = readers.get(s.fileIndex);
          if (!fh) {
            fh = await open(this.filePath(s.fileIndex), 'r');
            readers.set(s.fileIndex, fh);
          }
          await readFully(fh, buf, s.rangeOffset, s.length, s.fileOffset);
        }
        const expected = this.meta.pieces[i];
        this.bitfield.set(i, expected !== undefined && equalBytes(sha1(buf), expected));
      }
    } finally {
      await Promise.all([...readers.values()].map((fh) => fh.close().catch(() => undefined)));
    }
  }

  private handle(fileIndex: number): Promise<FileHandle> {
    let h = this.handles.get(fileIndex);
    if (!h) {
      const p = this.filePath(fileIndex);
      h = (async () => {
        await mkdir(dirname(p), { recursive: true });
        // O_CREAT without O_TRUNC/O_APPEND: positional writes into a possibly sparse file.
        return open(p, fsConstants.O_RDWR | fsConstants.O_CREAT);
      })();
      h.catch(() => this.handles.delete(fileIndex));
      this.handles.set(fileIndex, h);
    }
    return h;
  }

  /** True when `data` hashes to piece `index`. */
  verify(index: number, data: Uint8Array): boolean {
    const expected = this.meta.pieces[index];
    return expected !== undefined && data.length === this.pieceLength(index) && equalBytes(sha1(data), expected);
  }

  /**
   * Verifies and writes a complete piece, fsyncs the touched files, then marks
   * it present. Returns false (and writes nothing) on hash mismatch.
   */
  async writePiece(index: number, data: Uint8Array): Promise<boolean> {
    if (this.closed) throw new Error('storage closed');
    if (!this.verify(index, data)) return false;
    const touched = new Set<FileHandle>();
    for (const s of this.segments(index)) {
      const fh = await this.handle(s.fileIndex);
      let written = 0;
      while (written < s.length) {
        const { bytesWritten } = await fh.write(data, s.rangeOffset + written, s.length - written, s.fileOffset + written);
        written += bytesWritten;
      }
      touched.add(fh);
    }
    await Promise.all([...touched].map((fh) => fh.datasync()));
    this.bitfield.set(index);
    this.scheduleBitfieldWrite();
    return true;
  }

  /** Reads a block of a verified piece (for serving peers). */
  async readBlock(index: number, offset: number, length: number): Promise<Uint8Array> {
    if (!this.has(index)) throw new Error(`piece ${index} not available`);
    if (offset < 0 || length <= 0 || offset + length > this.pieceLength(index)) throw new Error('block out of range');
    const buf = new Uint8Array(length);
    for (const s of this.segments(index, offset, length)) {
      const fh = await this.handle(s.fileIndex);
      await readFully(fh, buf, s.rangeOffset, s.length, s.fileOffset);
    }
    return buf;
  }

  private scheduleBitfieldWrite(delayMs = 1000): void {
    if (this.bitfieldTimer || this.closed) return;
    this.bitfieldTimer = setTimeout(() => {
      this.bitfieldTimer = undefined;
      void this.flushBitfield();
    }, delayMs);
    this.bitfieldTimer.unref();
  }

  /** Atomically writes the resume bitfield now. */
  flushBitfield(): Promise<void> {
    if (this.bitfieldTimer) {
      clearTimeout(this.bitfieldTimer);
      this.bitfieldTimer = undefined;
    }
    const snapshot = new Uint8Array(this.bitfield.buffer);
    this.bitfieldWrite = this.bitfieldWrite.then(async () => {
      const tmp = `${this.bitfieldPath}.tmp`;
      try {
        await writeFile(tmp, snapshot);
        await rename(tmp, this.bitfieldPath);
      } catch {
        /* resume is best-effort */
      }
    });
    return this.bitfieldWrite;
  }

  /** Closes open file handles (they reopen lazily on next use). */
  async closeHandles(): Promise<void> {
    const hs = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(hs.map(async (h) => (await h.catch(() => undefined))?.close().catch(() => undefined)));
  }

  /** Flushes the bitfield and closes handles. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flushBitfield();
    this.closed = true;
    await this.closeHandles();
  }

  /** Deletes payload files, now-empty directories under downloadDir, and the resume file. */
  async deleteFiles(): Promise<void> {
    this.closed = true;
    if (this.bitfieldTimer) clearTimeout(this.bitfieldTimer);
    await this.bitfieldWrite;
    await this.closeHandles();
    const dirs = new Set<string>();
    for (const f of this.meta.files) {
      const p = this.filePath(f.index);
      await rm(p, { force: true });
      for (let d = dirname(p); d.startsWith(this.opts.downloadDir) && d !== this.opts.downloadDir; d = dirname(d)) dirs.add(d);
    }
    // Deepest first; rmdir fails (ignored) on non-empty directories.
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(d).catch(() => undefined);
    await rm(this.bitfieldPath, { force: true });
  }
}

async function readFully(fh: FileHandle, buf: Uint8Array, offset: number, length: number, position: number): Promise<void> {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, offset + done, length - done, position + done);
    if (bytesRead === 0) throw new Error('unexpected end of file');
    done += bytesRead;
  }
}
