/**
 * Dictionary store (spec §4.2.C.3 / §5): installed dictionaries, import
 * progress, and a render-time LRU cache of `VocabEnrichment`s.
 *
 * Enrichment is NEVER written into the persisted `SentenceExplanation`; it is
 * computed per render via `host.dict.enrichVocab` and memoised under
 * `${dictSetRevision}:${lemma}:${lemmaReading}:${partOfSpeech}:${meaning}`.
 * Every install / update / reorder / removal bumps `dictSetRevision`, so
 * stale cache entries are simply never addressed again.
 */
import { create } from 'zustand';
import type { DictionaryInfo, HostEvent, PlatformHost, VocabEnrichment, VocabEntry } from '@kotori/core';

export interface DictImportProgress {
  readonly title: string;
  readonly phase: string;
  readonly processedRows: number;
  readonly error?: string;
}

/** Max cached enrichments (one per distinct vocab key). */
export const ENRICH_CACHE_MAX = 2000;

const EMPTY_ENRICHMENT: VocabEnrichment = { status: 'empty', pitches: [], frequencies: [], senseGroups: [] };

/** Tiny insertion-ordered LRU over `Map`. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(readonly max: number) {}
  get size(): number {
    return this.map.size;
  }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

const cache = new LruCache<VocabEnrichment>(ENRICH_CACHE_MAX);
/** The host the cache / list belong to (a new host ⇒ fresh state). */
let boundHost: PlatformHost | undefined;
let loading: Promise<void> | undefined;

export function enrichmentCacheKey(revision: number, v: Pick<VocabEntry, 'lemma' | 'lemmaReading' | 'partOfSpeech' | 'meaning'>): string {
  return `${revision}:${v.lemma}:${v.lemmaReading}:${v.partOfSpeech}:${v.meaning}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DictState {
  readonly dictionaries: readonly DictionaryInfo[];
  /** `true` once `load()` resolved for the bound host. */
  readonly loaded: boolean;
  readonly dictSetRevision: number;
  readonly importProgress: Readonly<Record<string, DictImportProgress>>;
  /** Number of cached enrichments (diagnostics + tests). */
  readonly cacheSize: number;

  load(host: PlatformHost): Promise<void>;
  /** Load once per host (concurrent callers share the request). */
  ensureLoaded(host: PlatformHost): Promise<void>;
  importPreset(host: PlatformHost, presetId: string): Promise<DictionaryInfo | undefined>;
  importZipBytes(host: PlatformHost, fileName: string, bytes: Uint8Array): Promise<DictionaryInfo | undefined>;
  importFilePath(host: PlatformHost, filePath: string): Promise<DictionaryInfo | undefined>;
  toggleEnabled(host: PlatformHost, id: string, enabled: boolean): Promise<void>;
  movePriority(host: PlatformHost, id: string, direction: 'up' | 'down'): Promise<void>;
  remove(host: PlatformHost, id: string): Promise<void>;
  /** Render-time enrichment keyed by `VocabEntry.id` (LRU-cached; empty when no dictionaries). */
  enrich(host: PlatformHost, vocab: readonly VocabEntry[]): Promise<Record<string, VocabEnrichment>>;
  /** Synchronous cache probe: the full result when every item is cached, else `undefined`. */
  peekEnrichment(host: PlatformHost, vocab: readonly VocabEntry[]): Record<string, VocabEnrichment> | undefined;
  /** Feed host events (`dict-import-progress`). */
  handleEvent(host: PlatformHost, event: HostEvent): void;
  clearProgress(id: string): void;
  reset(): void;
}

const initial = {
  dictionaries: [] as readonly DictionaryInfo[],
  loaded: false,
  dictSetRevision: 0,
  importProgress: {} as Readonly<Record<string, DictImportProgress>>,
  cacheSize: 0,
};

/** Usable = ready + enabled. */
export function usableDictionaries(dicts: readonly DictionaryInfo[]): DictionaryInfo[] {
  return dicts.filter((d) => d.status === 'ready' && d.enabled);
}

export const useDictStore = create<DictState>()((set, get) => {
  const bind = (host: PlatformHost): void => {
    if (boundHost === host) return;
    boundHost = host;
    loading = undefined;
    cache.clear();
    set({ dictionaries: [], loaded: false, importProgress: {}, cacheSize: 0, dictSetRevision: get().dictSetRevision + 1 });
  };

  const setProgress = (id: string, p: DictImportProgress): void => set((s) => ({ importProgress: { ...s.importProgress, [id]: p } }));

  const runImport = async (host: PlatformHost, key: string, title: string, start: () => Promise<DictionaryInfo>): Promise<DictionaryInfo | undefined> => {
    bind(host);
    setProgress(key, { title, phase: 'importing', processedRows: 0 });
    try {
      const info = await start();
      set((s) => {
        const { [key]: _drop, ...rest } = s.importProgress;
        return { importProgress: { ...rest, [info.id]: { title: info.title, phase: 'ready', processedRows: info.termCount + info.metaCount } } };
      });
      await get().load(host);
      return info;
    } catch (e) {
      setProgress(key, { title, phase: 'failed', processedRows: get().importProgress[key]?.processedRows ?? 0, error: errorMessage(e) });
      return undefined;
    }
  };

  return {
    ...initial,

    async load(host) {
      bind(host);
      if (!host.dict) {
        set((s) => ({ dictionaries: [], loaded: true, dictSetRevision: s.dictSetRevision + 1 }));
        return;
      }
      const list = await host.dict.list();
      if (boundHost !== host) return;
      set((s) => ({ dictionaries: list, loaded: true, dictSetRevision: s.dictSetRevision + 1 }));
    },

    ensureLoaded(host) {
      bind(host);
      if (get().loaded) return Promise.resolve();
      if (!loading) {
        const p = get()
          .load(host)
          .catch(() => {
            set({ loaded: true });
          })
          .finally(() => {
            if (loading === p) loading = undefined;
          });
        loading = p;
      }
      return loading;
    },

    importPreset(host, presetId) {
      if (!host.dict) return Promise.resolve(undefined);
      const dict = host.dict;
      return runImport(host, presetId, presetId, () => dict.importZip({ presetId }));
    },

    importZipBytes(host, fileName, bytes) {
      if (!host.dict) return Promise.resolve(undefined);
      const dict = host.dict;
      return runImport(host, `file:${fileName}`, fileName, () => dict.importZip({ bytes, fileName }));
    },

    importFilePath(host, filePath) {
      if (!host.dict) return Promise.resolve(undefined);
      const dict = host.dict;
      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      return runImport(host, `file:${name}`, name, () => dict.importZip({ filePath, fileName: name }));
    },

    async toggleEnabled(host, id, enabled) {
      if (!host.dict) return;
      bind(host);
      const updated = await host.dict.update(id, { enabled });
      set((s) => ({ dictionaries: s.dictionaries.map((d) => (d.id === id ? updated : d)), dictSetRevision: s.dictSetRevision + 1 }));
    },

    async movePriority(host, id, direction) {
      if (!host.dict) return;
      bind(host);
      const ordered = [...get().dictionaries].sort((a, b) => a.priority - b.priority);
      const i = ordered.findIndex((d) => d.id === id);
      const j = direction === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ordered.length) return;
      const a = ordered[i]!;
      const b = ordered[j]!;
      [ordered[i], ordered[j]] = [b, a];
      // Renumber densely so equal priorities can never tie.
      const patches = ordered.map((d, idx) => ({ d, priority: idx })).filter(({ d, priority }) => d.priority !== priority);
      const dict = host.dict;
      const updated = await Promise.all(patches.map(({ d, priority }) => dict.update(d.id, { priority })));
      const byId = new Map(updated.map((u) => [u.id, u]));
      set((s) => ({ dictionaries: s.dictionaries.map((d) => byId.get(d.id) ?? d).sort((x, y) => x.priority - y.priority), dictSetRevision: s.dictSetRevision + 1 }));
    },

    async remove(host, id) {
      if (!host.dict) return;
      bind(host);
      await host.dict.remove(id);
      set((s) => {
        const { [id]: _drop, ...rest } = s.importProgress;
        return { dictionaries: s.dictionaries.filter((d) => d.id !== id), importProgress: rest, dictSetRevision: s.dictSetRevision + 1 };
      });
    },

    async enrich(host, vocab) {
      const out: Record<string, VocabEnrichment> = {};
      if (vocab.length === 0) return out;
      if (!host.dict) {
        for (const v of vocab) out[v.id] = EMPTY_ENRICHMENT;
        return out;
      }
      await get().ensureLoaded(host);
      if (usableDictionaries(get().dictionaries).length === 0) {
        for (const v of vocab) out[v.id] = EMPTY_ENRICHMENT;
        return out;
      }
      const revision = get().dictSetRevision;
      const misses: VocabEntry[] = [];
      for (const v of vocab) {
        const hit = cache.get(enrichmentCacheKey(revision, v));
        if (hit) out[v.id] = hit;
        else misses.push(v);
      }
      if (misses.length === 0) return out;
      const fresh = await host.dict.enrichVocab(misses);
      const stillCurrent = boundHost === host && get().dictSetRevision === revision;
      for (const v of misses) {
        const e = fresh[v.id] ?? EMPTY_ENRICHMENT;
        out[v.id] = e;
        if (stillCurrent) cache.set(enrichmentCacheKey(revision, v), e);
      }
      if (stillCurrent) set({ cacheSize: cache.size });
      return out;
    },

    peekEnrichment(host, vocab) {
      const s = get();
      if (!host.dict) {
        const out: Record<string, VocabEnrichment> = {};
        for (const v of vocab) out[v.id] = EMPTY_ENRICHMENT;
        return out;
      }
      if (boundHost !== host || !s.loaded) return undefined;
      const out: Record<string, VocabEnrichment> = {};
      if (usableDictionaries(s.dictionaries).length === 0) {
        for (const v of vocab) out[v.id] = EMPTY_ENRICHMENT;
        return out;
      }
      for (const v of vocab) {
        const hit = cache.get(enrichmentCacheKey(s.dictSetRevision, v));
        if (!hit) return undefined;
        out[v.id] = hit;
      }
      return out;
    },

    handleEvent(host, event) {
      if (event.type !== 'dict-import-progress') return;
      bind(host);
      // A host-assigned id supersedes the provisional `file:<name>` row of a local import.
      set((s) => {
        const next: Record<string, DictImportProgress> = {};
        for (const [k, p] of Object.entries(s.importProgress)) {
          if (k.startsWith('file:') && k !== event.dictId && p.title.replace(/\.zip$/i, '') === event.title) continue;
          next[k] = p;
        }
        return { importProgress: next };
      });
      setProgress(event.dictId, {
        title: event.title,
        phase: event.phase,
        processedRows: event.processedRows,
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
      if (event.phase === 'ready') void get().load(host).catch(() => {});
    },

    clearProgress(id) {
      set((s) => {
        const { [id]: _drop, ...rest } = s.importProgress;
        return { importProgress: rest };
      });
    },

    reset() {
      boundHost = undefined;
      loading = undefined;
      cache.clear();
      set({ ...initial });
    },
  };
});
