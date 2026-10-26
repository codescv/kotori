/** MSB-first bitfield (BitTorrent wire order), fixed length. */
export class BitField {
  readonly length: number;
  readonly buffer: Uint8Array;

  constructor(length: number, buffer?: Uint8Array) {
    this.length = length;
    const bytes = Math.ceil(length / 8);
    this.buffer = new Uint8Array(bytes);
    if (buffer) this.buffer.set(buffer.subarray(0, bytes));
    // Clear spare bits past `length` so `count()` stays exact.
    const spare = bytes * 8 - length;
    if (spare > 0 && bytes > 0) this.buffer[bytes - 1] = (this.buffer[bytes - 1] ?? 0) & (0xff << spare);
  }

  get(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    return ((this.buffer[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0;
  }

  set(i: number, value = true): void {
    if (i < 0 || i >= this.length) return;
    const b = i >> 3;
    const mask = 0x80 >> (i & 7);
    const cur = this.buffer[b] ?? 0;
    this.buffer[b] = value ? cur | mask : cur & ~mask;
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.length; i++) if (this.get(i)) n++;
    return n;
  }

  isFull(): boolean {
    return this.count() === this.length;
  }
}
