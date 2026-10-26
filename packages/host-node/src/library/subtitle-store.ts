/**
 * Kotori-managed subtitle files: downloaded (Jimaku), extracted (ffmpeg) and
 * imported (browser upload) subtitles live under
 * `{dataDir}/subtitles/{episodeId}/`.
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { Id } from '@kotori/core';

const MAX_NAME_BYTES = 200;

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Make a file name safe for any filesystem (keeps CJK; ≤ 200 UTF-8 bytes; extension preserved). */
export function sanitizeFileName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  if (!cleaned) return 'subtitle';
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(cleaned)?.[0] ?? '';
  const stemPart = cleaned.slice(0, cleaned.length - ext.length);
  return truncateUtf8(stemPart, MAX_NAME_BYTES - ext.length).trimEnd() + ext || 'subtitle';
}

export class SubtitleStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'subtitles');
  }

  dirFor(episodeId: Id): string {
    return join(this.root, sanitizeFileName(episodeId));
  }

  /** True when `path` is inside the managed subtitle directory. */
  isManaged(path: string): boolean {
    const abs = resolve(path);
    return abs.startsWith(this.root + sep);
  }

  async writeText(episodeId: Id, fileName: string, content: string): Promise<string> {
    return this.writeBytes(episodeId, fileName, new TextEncoder().encode(content));
  }

  async writeBytes(episodeId: Id, fileName: string, bytes: Uint8Array): Promise<string> {
    const dir = this.dirFor(episodeId);
    await mkdir(dir, { recursive: true });
    const target = join(dir, sanitizeFileName(fileName));
    await writeFile(target, bytes);
    return target;
  }

  async copyFrom(episodeId: Id, sourcePath: string, fileName: string = basename(sourcePath)): Promise<string> {
    const dir = this.dirFor(episodeId);
    await mkdir(dir, { recursive: true });
    const target = join(dir, sanitizeFileName(fileName));
    if (resolve(sourcePath) !== target) await copyFile(sourcePath, target);
    return target;
  }

  /** Path for a new extraction output (caller writes it). */
  async allocate(episodeId: Id, fileName: string): Promise<string> {
    const dir = this.dirFor(episodeId);
    await mkdir(dir, { recursive: true });
    return join(dir, sanitizeFileName(fileName));
  }

  async removeFile(path: string): Promise<void> {
    if (this.isManaged(path)) await rm(path, { force: true });
  }

  async removeEpisode(episodeId: Id): Promise<void> {
    await rm(this.dirFor(episodeId), { recursive: true, force: true });
  }
}
