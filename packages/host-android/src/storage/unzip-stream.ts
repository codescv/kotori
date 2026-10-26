/**
 * Streaming ZIP extraction for the WebView (fflate `Unzip` + `UnzipInflate`).
 *
 * `unzipSync` needs the whole archive *and* every inflated entry in memory at
 * once — for a 100–300 MB manga volume that is several hundred MB of JS heap
 * on top of the base64 copy `Filesystem.readFile` produces, a likely OOM on
 * mid-range phones. Here the archive is consumed chunk-by-chunk from a
 * `ReadableStream` and each matching entry is handed to `onEntry` as soon as
 * it is complete; the producer waits for pending writes (back-pressure), so
 * peak memory is roughly one chunk + one entry.
 */
import { Unzip, UnzipInflate, unzipSync } from 'fflate';

export type UnzipFilter = (name: string) => boolean;

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Extract entries matching `filter` from a ZIP byte stream. Entries are
 * delivered in archive order; `onEntry` calls run sequentially.
 */
export async function unzipStream(
  stream: ReadableStream<Uint8Array>,
  filter: UnzipFilter,
  onEntry: (name: string, data: Uint8Array) => Promise<void>,
): Promise<number> {
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;
  let count = 0;
  const unzipper = new Unzip((file) => {
    if (file.name.endsWith('/') || !filter(file.name)) return;
    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (error) {
        failure ??= error;
        return;
      }
      parts.push(data);
      size += data.length;
      if (final) {
        const bytes = concat(parts, size);
        count += 1;
        chain = chain.then(() => onEntry(file.name, bytes)).catch((e: unknown) => {
          failure ??= e;
        });
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      unzipper.push(value, false);
      // Back-pressure: don't read further while entries are still being written.
      await chain;
      if (failure !== undefined) throw failure;
    }
    unzipper.push(new Uint8Array(0), true);
    await chain;
  } finally {
    reader.releaseLock();
  }
  if (failure !== undefined) throw failure;
  return count;
}

/**
 * `unzipStream` with a whole-buffer fallback for archives the streaming
 * decoder cannot handle (e.g. STORED entries written with data descriptors).
 */
export async function extractZip(
  open: () => Promise<ReadableStream<Uint8Array>>,
  readAll: () => Promise<Uint8Array>,
  filter: UnzipFilter,
  onEntry: (name: string, data: Uint8Array) => Promise<void>,
): Promise<number> {
  const seen = new Set<string>();
  try {
    return await unzipStream(await open(), filter, async (name, data) => {
      seen.add(name);
      await onEntry(name, data);
    });
  } catch (error) {
    console.warn('[kotori:host-android] streaming unzip failed, falling back to in-memory extraction', error);
    const entries = unzipSync(await readAll(), { filter: (f) => !f.name.endsWith('/') && filter(f.name) && !seen.has(f.name) });
    for (const [name, data] of Object.entries(entries)) await onEntry(name, data);
    return seen.size + Object.keys(entries).length;
  }
}

/** Chunked stream over an in-memory buffer (tests / fallback `readFileStream`). */
export function bytesToStream(bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}
