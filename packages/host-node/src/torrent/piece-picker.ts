/**
 * Piece selection: rarest-first with a sequential bias for a priority file
 * (so playback can start while downloading) and end-game detection.
 *
 * Pure bookkeeping — no I/O, no timers — so it is unit-testable in isolation.
 */

export interface PiecePickerOptions {
  /** Random source for rarest-first tie-breaking (tests inject a deterministic one). */
  readonly random?: () => number;
  /**
   * How many of the first missing pieces of the priority range are fetched
   * strictly in order before falling back to rarest-first. Default 16.
   */
  readonly sequentialWindow?: number;
}

/** Half-open piece range `[start, end)`. */
export interface PieceRange {
  readonly start: number;
  readonly end: number;
}

export class PiecePicker {
  readonly numPieces: number;
  private readonly have: Uint8Array;
  private readonly wanted: Uint8Array;
  private readonly avail: Uint32Array;
  private readonly random: () => number;
  private readonly window: number;
  private priority: PieceRange | undefined;

  constructor(numPieces: number, opts: PiecePickerOptions = {}) {
    this.numPieces = numPieces;
    this.have = new Uint8Array(numPieces);
    this.wanted = new Uint8Array(numPieces).fill(1);
    this.avail = new Uint32Array(numPieces);
    this.random = opts.random ?? Math.random;
    this.window = opts.sequentialWindow ?? 16;
  }

  setHave(index: number, value = true): void {
    if (index >= 0 && index < this.numPieces) this.have[index] = value ? 1 : 0;
  }

  hasPiece(index: number): boolean {
    return this.have[index] === 1;
  }

  /** Marks which pieces are wanted (touch a selected file). */
  setWanted(isWanted: (index: number) => boolean): void {
    for (let i = 0; i < this.numPieces; i++) this.wanted[i] = isWanted(i) ? 1 : 0;
  }

  /** Wanted and not yet verified. */
  needs(index: number): boolean {
    return this.wanted[index] === 1 && this.have[index] === 0;
  }

  /** Number of wanted pieces still missing. */
  remaining(): number {
    let n = 0;
    for (let i = 0; i < this.numPieces; i++) if (this.needs(i)) n++;
    return n;
  }

  /** Counts a new peer's pieces into availability. */
  addPeer(peerHas: (index: number) => boolean): void {
    for (let i = 0; i < this.numPieces; i++) if (peerHas(i)) this.avail[i] = (this.avail[i] ?? 0) + 1;
  }

  /** Removes a departing peer's pieces from availability. */
  removePeer(peerHas: (index: number) => boolean): void {
    for (let i = 0; i < this.numPieces; i++) {
      const a = this.avail[i] ?? 0;
      if (peerHas(i) && a > 0) this.avail[i] = a - 1;
    }
  }

  /** A connected peer announced a new piece. */
  peerHave(index: number): void {
    if (index >= 0 && index < this.numPieces) this.avail[index] = (this.avail[index] ?? 0) + 1;
  }

  availability(index: number): number {
    return this.avail[index] ?? 0;
  }

  /** Sets (or clears) the range that gets the sequential bias, e.g. the current video file. */
  setPriorityRange(range: PieceRange | undefined): void {
    this.priority = range && range.end > range.start ? range : undefined;
  }

  get priorityRange(): PieceRange | undefined {
    return this.priority;
  }

  /**
   * Picks the next piece to start from a peer: first the head window of the
   * priority range in order (plus its last piece, where containers keep
   * indexes), then the globally rarest piece the peer has. `active` pieces are
   * already being downloaded and are skipped.
   */
  pick(peerHas: (index: number) => boolean, active: ReadonlySet<number>): number | undefined {
    const ok = (i: number): boolean => this.needs(i) && !active.has(i) && peerHas(i);
    const pr = this.priority;
    if (pr) {
      let seen = 0;
      for (let i = pr.start; i < pr.end && seen < this.window; i++) {
        if (!this.needs(i)) continue;
        seen++;
        if (!active.has(i) && peerHas(i)) return i;
      }
      const tail = pr.end - 1;
      if (ok(tail)) return tail;
    }
    let best: number | undefined;
    let bestAvail = Infinity;
    let ties = 0;
    for (let i = 0; i < this.numPieces; i++) {
      if (!ok(i)) continue;
      const a = this.avail[i] ?? 0;
      if (a < bestAvail) {
        best = i;
        bestAvail = a;
        ties = 1;
      } else if (a === bestAvail) {
        // Reservoir sampling among equally rare pieces.
        ties++;
        if (this.random() * ties < 1) best = i;
      }
    }
    return best;
  }

  /** End-game: every missing wanted piece is already in flight. */
  inEndgame(active: ReadonlySet<number>): boolean {
    let missing = 0;
    for (let i = 0; i < this.numPieces; i++) {
      if (!this.needs(i)) continue;
      missing++;
      if (!active.has(i)) return false;
    }
    return missing > 0;
  }
}
