/**
 * In-memory `DictionaryHost` for `MockPlatformHost`: stores `CompactTermRecord`
 * / `DictMetaRecord` rows in arrays and runs the real `@kotori/core`
 * enrichment (`enrichVocabBatch`) and click-to-lookup (`lookupPrefixBatch`)
 * pipelines over them. Imports are simulated (progress events, no parsing).
 */
import {
  findDictPreset,
  KotoriError,
  lookupPrefixBatch,
  enrichVocabBatch,
  type CompactTermRecord,
  type DictionaryHost,
  type DictionaryImportSource,
  type DictionaryInfo,
  type DictionaryLookupSource,
  type DictMetaRecord,
  type HostEvent,
} from '@kotori/core';
import { createMockDictionaryData, MOCK_DICTIONARIES } from './dictionaries';

export interface MockDictHostDeps {
  readonly seeded: boolean;
  readonly delay: () => Promise<void>;
  readonly emit: (event: HostEvent) => void;
  readonly track: (name: string) => void;
  readonly newId: (prefix: string) => string;
}

export function createMockDictHost({ seeded, delay, emit, track, newId }: MockDictHostDeps): DictionaryHost {
  const seed = createMockDictionaryData();
  let dictionaries: DictionaryInfo[] = seeded ? seed.dictionaries : [];
  let terms: CompactTermRecord[] = seeded ? seed.terms : [];
  let meta: DictMetaRecord[] = seeded ? seed.meta : [];

  const sorted = (): DictionaryInfo[] => [...dictionaries].sort((a, b) => a.priority - b.priority || a.importedAt - b.importedAt);
  const source = (): DictionaryLookupSource => ({
    dictionaries: sorted(),
    async findTerms(keys) {
      const want = new Set(keys);
      return terms.filter((t) => t.keys.some((k) => want.has(k)) || want.has(t.expression));
    },
    async findMeta(expressions) {
      const want = new Set(expressions);
      return meta.filter((m) => want.has(m.expression));
    },
  });
  const getDict = (id: string): DictionaryInfo => {
    const d = dictionaries.find((x) => x.id === id);
    if (!d) throw new KotoriError('not-found', `dictionary ${id} not found`);
    return d;
  };

  return {
    async list() {
      track('dict.list');
      await delay();
      return sorted();
    },

    async importZip(src: DictionaryImportSource) {
      track('dict.importZip');
      const preset = src.presetId ? findDictPreset(src.presetId) : undefined;
      if (src.presetId && !preset) throw new KotoriError('not-found', `unknown dictionary preset ${src.presetId}`);
      const fileName = src.fileName ?? src.filePath?.split(/[\\/]/).pop() ?? (src.url ?? preset?.downloadUrl)?.split('/').pop()?.split('?')[0] ?? 'dictionary.zip';
      if (!preset && !src.url && !/\.zip$/i.test(fileName)) throw new KotoriError('invalid-argument', `${fileName} is not a Yomitan v3 .zip`);
      if (src.bytes && src.bytes.length >= 2 && !(src.bytes[0] === 0x50 && src.bytes[1] === 0x4b)) throw new KotoriError('invalid-argument', `${fileName} is not a ZIP archive`);

      const seededInfo = MOCK_DICTIONARIES.find((d) => d.id === preset?.id);
      const id = preset?.id ?? newId('dict');
      const title = seededInfo?.title ?? preset?.title ?? fileName.replace(/\.zip$/i, '');
      const progress = (phase: 'downloading' | 'importing' | 'ready' | 'failed', processedRows: number): void =>
        emit({ type: 'dict-import-progress', dictId: id, title, phase, processedRows });

      if (preset || src.url) {
        progress('downloading', 0);
        await delay();
      }
      for (const rows of [2_500, 5_000, 7_500]) {
        progress('importing', rows);
        await delay();
      }

      // Blue-green: the replacement inherits priority / enabled of the old copy.
      const previous = dictionaries.find((d) => d.id === id);
      if (seededInfo) {
        const fresh = createMockDictionaryData();
        terms = [...terms.filter((t) => t.dictId !== id), ...fresh.terms.filter((t) => t.dictId === id)];
        meta = [...meta.filter((m) => m.dictId !== id), ...fresh.meta.filter((m) => m.dictId === id)];
      }
      const attribution = src.attribution ?? preset?.attribution ?? seededInfo?.attribution;
      const sourceUrl = src.url ?? preset?.downloadUrl;
      const indexUrl = src.indexUrl ?? preset?.indexUrl;
      const info: DictionaryInfo = {
        id,
        title,
        revision: seededInfo?.revision ?? new Date().toISOString().slice(0, 10),
        kind: seededInfo?.kind ?? preset?.kind ?? 'term',
        status: 'ready',
        priority: previous?.priority ?? Math.max(-1, ...dictionaries.map((d) => d.priority)) + 1,
        enabled: previous?.enabled ?? true,
        termCount: seededInfo?.termCount ?? 7_500,
        metaCount: seededInfo?.metaCount ?? 0,
        ...(attribution !== undefined ? { attribution } : {}),
        ...(sourceUrl !== undefined ? { sourceUrl } : {}),
        ...(indexUrl !== undefined ? { indexUrl } : {}),
        importedAt: Date.now(),
      };
      dictionaries = [...dictionaries.filter((d) => d.id !== id), info];
      progress('ready', 7_500);
      return info;
    },

    async update(id, patch) {
      track('dict.update');
      await delay();
      const d = getDict(id);
      const updated: DictionaryInfo = { ...d, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.priority !== undefined ? { priority: patch.priority } : {}) };
      dictionaries = dictionaries.map((x) => (x.id === id ? updated : x));
      return updated;
    },

    async remove(id) {
      track('dict.remove');
      await delay();
      getDict(id);
      dictionaries = dictionaries.filter((d) => d.id !== id);
      terms = terms.filter((t) => t.dictId !== id);
      meta = meta.filter((m) => m.dictId !== id);
    },

    async enrichVocab(vocab) {
      track('dict.enrichVocab');
      await delay();
      return enrichVocabBatch(vocab, source());
    },

    async lookupPrefix(text, maxLength = 16) {
      track('dict.lookupPrefix');
      await delay();
      return lookupPrefixBatch(text, source(), maxLength);
    },
  };
}
