/**
 * Byte-level streaming splitter for huge top-level JSON arrays (Yomitan
 * `term_bank_*.json` / `term_meta_bank_*.json`, up to 30+ MB per file).
 *
 * Designed to sit directly on `fflate`'s `UnzipFile.ondata`: it receives UTF-8
 * chunks, tracks bracket depth / string / escape state byte by byte, and emits
 * every top-level array element as soon as it is complete — decoding and
 * `JSON.parse`-ing ONE row at a time. The whole bank is never concatenated
 * into a single `Uint8Array` or string, so peak memory is roughly
 * "one inflate chunk + one row" regardless of bank size (spec §4.2.B).
 *
 * Every structural byte (`[ ] { } " \ ,`) is ASCII, and UTF-8 continuation
 * bytes are always ≥ 0x80, so scanning raw bytes can never mistake part of a
 * multi-byte kanji for a delimiter. Rows split across chunks are carried as
 * small copied slices and decoded only once complete, so multi-byte
 * characters cut at a chunk boundary decode correctly.
 */

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACKET = 0x5d; // ]
const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }
const COMMA = 0x2c; // ,

function isJsonWhitespace(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
}

/** Element kinds at depth 1: containers, strings, or bare scalars (numbers / true / false / null). */
type ElementKind = 'container' | 'string' | 'scalar';

export class JsonArrayRowSplitter {
  /** 0 = before the outer `[`, 1 = inside the outer array, ≥2 = inside an element container. */
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Outer array has been closed by its `]`. */
  private closed = false;
  private element: ElementKind | undefined;
  /** Copied slices of the current element from previous chunks (usually empty or tiny). */
  private carry: Uint8Array[] = [];
  private carryLength = 0;
  private rows = 0;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly onRow: (row: unknown, index: number) => void) {}

  /** Number of rows emitted so far. */
  get rowCount(): number {
    return this.rows;
  }

  /** True once the outer array's closing `]` has been seen. */
  get done(): boolean {
    return this.closed;
  }

  /** Feed the next UTF-8 chunk. Throws on malformed JSON rows (with row index context). */
  push(chunk: Uint8Array): void {
    let start = this.element !== undefined ? 0 : -1;
    const n = chunk.length;
    for (let i = 0; i < n; i++) {
      const b = chunk[i]!;

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (b === BACKSLASH) this.escaped = true;
        else if (b === QUOTE) {
          this.inString = false;
          if (this.element === 'string') {
            this.emit(chunk, start, i + 1);
            start = -1;
          }
        }
        continue;
      }

      if (this.closed) continue;

      if (this.depth === 0) {
        if (b === OPEN_BRACKET) this.depth = 1;
        continue; // BOM / whitespace before the outer array
      }

      if (this.element === undefined) {
        // depth === 1, between elements
        if (isJsonWhitespace(b) || b === COMMA) continue;
        if (b === CLOSE_BRACKET) {
          this.depth = 0;
          this.closed = true;
          continue;
        }
        start = i;
        if (b === OPEN_BRACKET || b === OPEN_BRACE) {
          this.element = 'container';
          this.depth = 2;
        } else if (b === QUOTE) {
          this.element = 'string';
          this.inString = true;
        } else {
          this.element = 'scalar';
        }
        continue;
      }

      if (this.element === 'scalar') {
        if (b === COMMA || b === CLOSE_BRACKET || isJsonWhitespace(b)) {
          this.emit(chunk, start, i);
          start = -1;
          if (b === CLOSE_BRACKET) {
            this.depth = 0;
            this.closed = true;
          }
        }
        continue;
      }

      // Inside a container element (depth ≥ 2).
      if (b === QUOTE) this.inString = true;
      else if (b === OPEN_BRACKET || b === OPEN_BRACE) this.depth++;
      else if (b === CLOSE_BRACKET || b === CLOSE_BRACE) {
        this.depth--;
        if (this.depth === 1) {
          this.emit(chunk, start, i + 1);
          start = -1;
        }
      }
    }

    if (this.element !== undefined && start >= 0 && start < n) {
      // Copy: upstream (fflate) may reuse its output buffer between callbacks.
      const piece = chunk.slice(start);
      this.carry.push(piece);
      this.carryLength += piece.length;
    }
  }

  /**
   * Signal end of input. Flushes a trailing bare scalar; throws when the
   * input ended in the middle of a row (truncated / corrupt bank).
   */
  end(): void {
    if (this.element === 'scalar') {
      this.emit(new Uint8Array(0), 0, 0);
      return;
    }
    if (this.element !== undefined || this.inString) {
      throw new Error(`JSON array truncated inside row ${this.rows}`);
    }
  }

  private emit(chunk: Uint8Array, start: number, endExclusive: number): void {
    const s = start < 0 ? 0 : start;
    let bytes: Uint8Array;
    if (this.carryLength === 0) {
      bytes = chunk.subarray(s, endExclusive);
    } else {
      const tailLength = endExclusive - s;
      bytes = new Uint8Array(this.carryLength + tailLength);
      let off = 0;
      for (const c of this.carry) {
        bytes.set(c, off);
        off += c.length;
      }
      bytes.set(chunk.subarray(s, endExclusive), off);
      this.carry = [];
      this.carryLength = 0;
    }
    this.element = undefined;
    const index = this.rows++;
    const text = this.decoder.decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in row ${index}: ${msg}`);
    }
    this.onRow(parsed, index);
  }
}

/**
 * Convenience wrapper: split a (sync or async) stream of UTF-8 chunks into
 * rows. Resolves with the number of rows emitted.
 */
export async function streamJsonArrayRows(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  onRow: (row: unknown, index: number) => void | Promise<void>,
): Promise<number> {
  const pending: unknown[] = [];
  const splitter = new JsonArrayRowSplitter((row) => {
    pending.push(row);
  });
  let index = 0;
  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const row = pending.shift();
      await onRow(row, index++);
    }
  };
  for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
    splitter.push(chunk);
    await drain();
  }
  splitter.end();
  await drain();
  return splitter.rowCount;
}
