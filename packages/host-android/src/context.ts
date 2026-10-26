/**
 * Shared plumbing for the host modules: context object, stable ids, and a
 * keyed debouncer for fire-and-forget progress persistence.
 */
import type { HostEvent } from '@kotori/core';
import type { CapacitorHostDeps } from './deps';
import type { SettingsStore } from './settings';
import type { AppDirs } from './storage/files';
import type { KotoriDb } from './storage/idb';

export interface HostContext {
  readonly deps: CapacitorHostDeps;
  readonly db: KotoriDb;
  readonly dirs: AppDirs;
  readonly settings: SettingsStore;
  readonly emit: (event: HostEvent) => void;
}

/** 32-bit FNV-1a, hex. */
function fnv1a32(input: string, seed = 0x811c9dc5): string {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic id from an input string (same path ⇒ same id across rescans). */
export function stableId(prefix: string, input: string): string {
  return `${prefix}_${fnv1a32(input)}${fnv1a32(input, 0x01000193)}`;
}

let counter = 0;

/** Unique id for user-created records. */
export function uniqueId(prefix: string, now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${now.toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Per-key trailing debouncer whose pending work can be flushed (dispose / reads). */
export class KeyedDebouncer<V> {
  private readonly pending = new Map<string, { value: V; timer: ReturnType<typeof setTimeout> | undefined }>();

  constructor(
    private readonly delayMs: number,
    private readonly write: (key: string, value: V) => Promise<void>,
  ) {}

  /** Latest pending value for a key (so reads see unsaved progress). */
  peek(key: string): V | undefined {
    return this.pending.get(key)?.value;
  }

  schedule(key: string, value: V): Promise<void> {
    const existing = this.pending.get(key);
    if (existing?.timer !== undefined) clearTimeout(existing.timer);
    if (this.delayMs <= 0) {
      this.pending.delete(key);
      return this.write(key, value);
    }
    const timer = setTimeout(() => {
      void this.flushKey(key);
    }, this.delayMs);
    this.pending.set(key, { value, timer });
    return Promise.resolve();
  }

  async flushKey(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.pending.delete(key);
    try {
      await this.write(key, entry.value);
    } catch (error) {
      console.warn('[kotori:host-android] progress save failed', error);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((key) => this.flushKey(key)));
  }
}
