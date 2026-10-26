/** Rate limiting (token bucket) and throughput measurement. */

/** Token bucket in bytes/s. `rateBps` ≤ 0 or undefined means unlimited. */
export class TokenBucket {
  private rate: number;
  private tokens: number;
  private last: number;
  private readonly now: () => number;

  constructor(rateBps: number | undefined, now: () => number = Date.now) {
    this.now = now;
    this.rate = rateBps && rateBps > 0 ? rateBps : 0;
    this.tokens = this.rate;
    this.last = now();
  }

  get unlimited(): boolean {
    return this.rate === 0;
  }

  setRate(rateBps: number | undefined): void {
    this.refill();
    this.rate = rateBps && rateBps > 0 ? rateBps : 0;
    this.tokens = Math.min(this.tokens, this.rate);
  }

  private refill(): void {
    const t = this.now();
    if (this.rate > 0) this.tokens = Math.min(this.rate, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }

  /** Takes `n` tokens if available (a single request may exceed the burst once the bucket is full). */
  tryTake(n: number): boolean {
    if (this.rate === 0) return true;
    this.refill();
    if (this.tokens >= Math.min(n, this.rate)) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens would be available. */
  waitMs(n: number): number {
    if (this.rate === 0) return 0;
    this.refill();
    const need = Math.min(n, this.rate) - this.tokens;
    return need <= 0 ? 0 : Math.ceil((need / this.rate) * 1000);
  }

  /** Resolves once `n` tokens were taken. */
  async take(n: number): Promise<void> {
    while (!this.tryTake(n)) {
      await new Promise((r) => setTimeout(r, Math.max(5, this.waitMs(n))));
    }
  }
}

/** Sliding-window throughput meter (1 s buckets over `windowSec`). */
export class SpeedMeter {
  private readonly buckets: Float64Array;
  private readonly windowSec: number;
  private lastSec: number;
  private readonly now: () => number;

  constructor(windowSec = 5, now: () => number = Date.now) {
    this.windowSec = windowSec;
    this.buckets = new Float64Array(windowSec);
    this.now = now;
    this.lastSec = Math.floor(now() / 1000);
  }

  private advance(): number {
    const sec = Math.floor(this.now() / 1000);
    const gap = Math.min(sec - this.lastSec, this.windowSec);
    for (let i = 1; i <= gap; i++) this.buckets[(this.lastSec + i) % this.windowSec] = 0;
    if (sec > this.lastSec) this.lastSec = sec;
    return sec;
  }

  add(bytes: number): void {
    const sec = this.advance();
    const i = sec % this.windowSec;
    this.buckets[i] = (this.buckets[i] ?? 0) + bytes;
  }

  /** Bytes per second averaged over the window. */
  bps(): number {
    this.advance();
    let total = 0;
    for (const b of this.buckets) total += b;
    return total / this.windowSec;
  }
}
