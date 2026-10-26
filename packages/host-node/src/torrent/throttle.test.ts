import { describe, expect, it } from 'vitest';
import { SpeedMeter, TokenBucket } from './throttle';

describe('TokenBucket', () => {
  it('is a no-op when unlimited', () => {
    const b = new TokenBucket(undefined);
    expect(b.unlimited).toBe(true);
    expect(b.tryTake(1e12)).toBe(true);
    expect(b.waitMs(1e12)).toBe(0);
  });

  it('limits to the configured rate', () => {
    let now = 0;
    const b = new TokenBucket(1000, () => now);
    expect(b.tryTake(600)).toBe(true);
    expect(b.tryTake(600)).toBe(false);
    expect(b.waitMs(600)).toBe(200);
    now += 200;
    expect(b.tryTake(600)).toBe(true);
    b.setRate(0);
    expect(b.tryTake(1e9)).toBe(true);
  });
});

describe('SpeedMeter', () => {
  it('averages over a sliding window', () => {
    let now = 10_000;
    const m = new SpeedMeter(5, () => now);
    m.add(5000);
    expect(m.bps()).toBe(1000);
    now += 1000;
    m.add(5000);
    expect(m.bps()).toBe(2000);
    now += 10_000;
    expect(m.bps()).toBe(0);
  });
});
