/**
 * HTTP Range streaming for `<video>` (ARCHITECTURE.md §5.3): `206 Partial
 * Content` for `Range: bytes=a-b | a- | -n`, `416` with `Content-Range: bytes
 * *\/size` when unsatisfiable, `200` full body otherwise, header-only `HEAD`.
 * Framework-neutral (`Request` → `Response`); `serveRange` adapts to Hono.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
};

export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export type ByteRange = { readonly start: number; readonly end: number };

/**
 * Parse a `Range` header against a file size. Returns `undefined` when the
 * header is absent/unsupported (serve the whole file), `'unsatisfiable'` for
 * 416, else the first inclusive byte range (multi-range requests are served
 * as their first range, which every browser media stack accepts).
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m?.[1]) return undefined;
  const first = m[1].split(',')[0]?.trim() ?? '';
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(first);
  if (!parts) return undefined;
  const [, a = '', b = ''] = parts;
  if (a === '' && b === '') return undefined;
  if (size === 0) return 'unsatisfiable';
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size || end < start) return 'unsatisfiable';
  }
  return { start, end };
}

/** Build the Range-aware response for `filePath`. */
export async function rangeResponse(request: Request, filePath: string, mime: string = mimeForPath(filePath)): Promise<Response> {
  let size: number;
  let mtime: Date;
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return new Response('Not found', { status: 404 });
    size = st.size;
    mtime = st.mtime;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const baseHeaders: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-type': mime,
    'last-modified': mtime.toUTCString(),
    'cache-control': 'no-cache',
  };
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${size}` } });
  }
  const isHead = request.method === 'HEAD';
  if (!range) {
    const headers = { ...baseHeaders, 'content-length': String(size) };
    if (isHead || size === 0) return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>, { status: 200, headers });
  }
  const length = range.end - range.start + 1;
  const headers = { ...baseHeaders, 'content-length': String(length), 'content-range': `bytes ${range.start}-${range.end}/${size}` };
  if (isHead) return new Response(null, { status: 206, headers });
  const stream = createReadStream(filePath, { start: range.start, end: range.end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: 206, headers });
}

/** Hono adapter. */
export function serveRange(c: Context, filePath: string, mime?: string): Promise<Response> {
  return rangeResponse(c.req.raw, filePath, mime);
}
