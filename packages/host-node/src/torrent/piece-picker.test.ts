import { describe, expect, it } from 'vitest';
import { ActivePiece, BLOCK_SIZE } from './piece-buffer';
import { PiecePicker } from './piece-picker';

const all = (): boolean => true;
const none = new Set<number>();

describe('PiecePicker', () => {
  it('picks the rarest piece the peer has', () => {
    const p = new PiecePicker(6, { random: () => 0.99 });
    p.addPeer(all); // avail 1 everywhere
    p.addPeer((i) => i !== 4); // piece 4 now rarest (1), others 2
    expect(p.pick(all, none)).toBe(4);
    // The peer lacks piece 4 → next rarest tie → first (random never replaces).
    expect(p.pick((i) => i !== 4, none)).toBe(0);
    p.setHave(0);
    expect(p.pick((i) => i !== 4, none)).toBe(1);
    // Active pieces are skipped.
    expect(p.pick((i) => i !== 4, new Set([1, 2]))).toBe(3);
  });

  it('tracks availability as peers come and go', () => {
    const p = new PiecePicker(3, { random: () => 0.99 });
    p.addPeer((i) => i < 2);
    p.peerHave(2);
    p.peerHave(2);
    expect([0, 1, 2].map((i) => p.availability(i))).toEqual([1, 1, 2]);
    p.removePeer((i) => i < 2);
    expect([0, 1, 2].map((i) => p.availability(i))).toEqual([0, 0, 2]);
    expect(p.pick(all, none)).toBe(0);
  });

  it('only picks wanted, missing pieces', () => {
    const p = new PiecePicker(5);
    p.setWanted((i) => i >= 3);
    expect(p.remaining()).toBe(2);
    p.setHave(3);
    expect(p.pick(all, none)).toBe(4);
    p.setHave(4);
    expect(p.remaining()).toBe(0);
    expect(p.pick(all, none)).toBeUndefined();
  });

  it('applies a sequential bias to the priority range, including its last piece', () => {
    const p = new PiecePicker(100, { sequentialWindow: 3 });
    // Pieces 50..59 are the rarest overall; priority file covers 10..29.
    p.addPeer((i) => i < 50 || i >= 60);
    p.setPriorityRange({ start: 10, end: 30 });
    const active = new Set<number>();
    const order: number[] = [];
    for (let k = 0; k < 5; k++) {
      const i = p.pick(all, active);
      expect(i).toBeDefined();
      order.push(i!);
      active.add(i!);
    }
    // Head window in order, then the file's tail piece, then rarest-first.
    expect(order.slice(0, 4)).toEqual([10, 11, 12, 29]);
    expect(order[4]).toBeGreaterThanOrEqual(50);
    expect(order[4]).toBeLessThan(60);
    // Completed head pieces slide the window forward.
    for (const i of [10, 11, 12]) p.setHave(i);
    expect(p.pick(all, new Set([29]))).toBe(13);
  });

  it('respects what the peer has inside the priority window', () => {
    const p = new PiecePicker(20, { sequentialWindow: 4 });
    p.setPriorityRange({ start: 0, end: 10 });
    expect(p.pick((i) => i === 2 || i === 15, none)).toBe(2);
    expect(p.pick((i) => i === 15, none)).toBe(15);
  });

  it('detects end-game when every missing piece is in flight', () => {
    const p = new PiecePicker(4);
    p.setHave(0);
    p.setHave(1);
    expect(p.inEndgame(new Set([2]))).toBe(false);
    expect(p.inEndgame(new Set([2, 3]))).toBe(true);
    expect(p.pick(all, new Set([2, 3]))).toBeUndefined();
    p.setHave(2);
    p.setHave(3);
    expect(p.inEndgame(new Set())).toBe(false);
  });
});

describe('ActivePiece', () => {
  it('hands out blocks once, then duplicates in end-game and reports peers to cancel', () => {
    const ap = new ActivePiece<string>(7, BLOCK_SIZE * 2 + 100);
    expect(ap.blockCount).toBe(3);
    expect(ap.blockLength(2)).toBe(100);
    expect(ap.nextUnrequested()).toBe(0);
    ap.markRequested(0, 'A');
    ap.markRequested(1, 'A');
    ap.markRequested(2, 'A');
    expect(ap.nextUnrequested()).toBeUndefined();
    expect(ap.nextDuplicate('A')).toBeUndefined();
    expect(ap.nextDuplicate('B')).toBe(0);
    ap.markRequested(0, 'B');

    expect(ap.receive(0, new Uint8Array(BLOCK_SIZE).fill(1), 'B')).toEqual(['A']);
    expect(ap.receive(0, new Uint8Array(BLOCK_SIZE).fill(2), 'A')).toBeUndefined(); // duplicate ignored
    expect(ap.receive(1, new Uint8Array(5), 'A')).toBeUndefined(); // wrong size ignored
    ap.unmarkAll('A');
    expect(ap.nextUnrequested()).toBe(1);
    ap.receive(1, new Uint8Array(BLOCK_SIZE).fill(3), 'B');
    ap.receive(2, new Uint8Array(100).fill(4), 'B');
    expect(ap.complete).toBe(true);
    expect(ap.buffer[0]).toBe(1);
    expect(ap.buffer[BLOCK_SIZE]).toBe(3);
    expect(ap.buffer[BLOCK_SIZE * 2 + 99]).toBe(4);
    ap.reset();
    expect(ap.complete).toBe(false);
    expect(ap.nextUnrequested()).toBe(0);
  });
});
