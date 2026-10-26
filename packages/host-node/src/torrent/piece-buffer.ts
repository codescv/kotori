/**
 * Block-level bookkeeping for pieces currently being downloaded: which 16 KiB
 * blocks were requested from whom, which arrived, and the assembled bytes.
 */

export const BLOCK_SIZE = 16 * 1024;

export class ActivePiece<Who = unknown> {
  readonly index: number;
  readonly length: number;
  readonly blockCount: number;
  readonly buffer: Uint8Array;
  private readonly received: Uint8Array;
  private readonly requesters: Array<Set<Who>>;
  private receivedCount = 0;

  constructor(index: number, length: number) {
    this.index = index;
    this.length = length;
    this.blockCount = Math.ceil(length / BLOCK_SIZE);
    this.buffer = new Uint8Array(length);
    this.received = new Uint8Array(this.blockCount);
    this.requesters = Array.from({ length: this.blockCount }, () => new Set<Who>());
  }

  blockOffset(block: number): number {
    return block * BLOCK_SIZE;
  }

  blockLength(block: number): number {
    return Math.min(BLOCK_SIZE, this.length - block * BLOCK_SIZE);
  }

  /** Block index for a byte offset, or -1 when it does not start a block. */
  blockAt(offset: number): number {
    return offset % BLOCK_SIZE === 0 && offset < this.length ? offset / BLOCK_SIZE : -1;
  }

  /** First block nobody has requested and that has not arrived. */
  nextUnrequested(): number | undefined {
    for (let b = 0; b < this.blockCount; b++) {
      if (this.received[b] === 0 && this.requesters[b]?.size === 0) return b;
    }
    return undefined;
  }

  /** End-game: first missing block not already requested from `who`. */
  nextDuplicate(who: Who): number | undefined {
    for (let b = 0; b < this.blockCount; b++) {
      if (this.received[b] === 0 && !this.requesters[b]?.has(who)) return b;
    }
    return undefined;
  }

  markRequested(block: number, who: Who): void {
    this.requesters[block]?.add(who);
  }

  unmarkRequested(block: number, who: Who): void {
    this.requesters[block]?.delete(who);
  }

  /** Drops every outstanding request held by `who` (peer disconnected). */
  unmarkAll(who: Who): void {
    for (const s of this.requesters) s.delete(who);
  }

  isRequestedBy(block: number, who: Who): boolean {
    return this.requesters[block]?.has(who) ?? false;
  }

  /**
   * Stores an arrived block. Returns the *other* peers that still have it
   * outstanding (to cancel in end-game), or `undefined` if it was a duplicate.
   */
  receive(block: number, data: Uint8Array, who: Who): Who[] | undefined {
    const reqs = this.requesters[block];
    reqs?.delete(who);
    if (this.received[block] === 1 || data.length !== this.blockLength(block)) return undefined;
    this.buffer.set(data, block * BLOCK_SIZE);
    this.received[block] = 1;
    this.receivedCount++;
    const others = reqs ? [...reqs] : [];
    reqs?.clear();
    return others;
  }

  get complete(): boolean {
    return this.receivedCount === this.blockCount;
  }

  /** Outstanding requesters across all blocks. */
  outstanding(): number {
    let n = 0;
    for (const s of this.requesters) n += s.size;
    return n;
  }

  /** Forget everything (hash failure). */
  reset(): void {
    this.received.fill(0);
    this.receivedCount = 0;
    for (const s of this.requesters) s.clear();
  }
}
