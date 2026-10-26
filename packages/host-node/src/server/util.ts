/** Small server-side utilities: stable ids, LRU cache, event hub. */
import { createHash } from 'node:crypto';
import type { HostEvent, Unsubscribe } from '@kotori/core';

/** Deterministic id from parts (stable across restarts / rescans). */
export function stableId(prefix: string, ...parts: readonly (string | number)[]): string {
  return `${prefix}_${createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16)}`;
}

/** Minimal LRU map. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  /** Remove entries whose key matches. */
  deleteWhere(pred: (key: K) => boolean): void {
    for (const k of [...this.map.keys()]) if (pred(k)) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

/** In-process `HostEvent` fan-out (SSE route + tests subscribe here). */
export class EventHub {
  private readonly listeners = new Set<(event: HostEvent) => void>();

  emit(event: HostEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (error) {
        console.error('[kotori:events] listener failed', error);
      }
    }
  }

  subscribe(listener: (event: HostEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
