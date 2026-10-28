/**
 * Click-to-lookup (P2): longest-prefix deinflection scan over the text after
 * the clicked character, matched against dictionary terms in one batched
 * query round (+ one round for redirect targets / meta), spec §4.5.
 */
import type { CompactTermRecord, DictionarySenseGroup, InstantLookupMatch } from '../types';
import { scanPrefixDeinflections, wordClassesMatchTermRules, type PrefixDeinflection } from './clean-deinflector';
import { buildEnrichContext, isUsableDictionary, lookupFrequencies, lookupPitches, type DictionaryLookupSource, type EnrichContext } from './disambiguate';
import { katakanaToHiragana } from './zh-script';

export interface InstantLookupOptions {
  /** Max matches returned (default 12). */
  readonly limit?: number;
}

function priorityOf(ctx: EnrichContext, dictId: string): number {
  return ctx.dictionaries.get(dictId)?.priority ?? Number.MAX_SAFE_INTEGER;
}

/** One-hop redirect inside the same dictionary; returns the row itself when it has senses and no target is loaded. */
function resolve(ctx: EnrichContext, rec: CompactTermRecord): CompactTermRecord[] {
  if (rec.redirectTo === undefined) return rec.senses.length > 0 ? [rec] : [];
  const target = rec.redirectTo;
  const targets = (ctx.termsByKey.get(target) ?? []).filter((t) => t.dictId === rec.dictId && t.expression === target && t.senses.length > 0);
  if (targets.length > 0) return targets;
  return rec.senses.length > 0 ? [rec] : [];
}

interface Group {
  readonly candidate: PrefixDeinflection;
  readonly lemma: string;
  readonly reading: string;
  readonly records: CompactTermRecord[];
}

/**
 * Turn prefix deinflection candidates into lookup matches using an already
 * fetched context. Candidates whose word classes do not fit a row's POS are
 * dropped (`wordClassesMatchTermRules`); rows are grouped by headword
 * `(expression, reading)` per candidate. Order: longest match first, then
 * fewer deinflection steps, then dictionary priority / row score.
 */
export function buildInstantLookupMatches(candidates: readonly PrefixDeinflection[], ctx: EnrichContext, options: InstantLookupOptions = {}): InstantLookupMatch[] {
  const limit = options.limit ?? 12;
  const groups = new Map<string, Group>();
  const order: string[] = [];
  for (const c of candidates) {
    const rows = (ctx.termsByKey.get(c.term) ?? []).filter((r) => ctx.dictionaries.has(r.dictId) && (r.expression === c.term || r.reading === katakanaToHiragana(c.term)) && wordClassesMatchTermRules(c.wordClasses, r.rules, r.defTags));
    for (const row of rows) {
      for (const rec of resolve(ctx, row)) {
        const reading = rec.reading !== '' ? rec.reading : row.reading;
        // A headword surfaces once, at its longest / shortest-chain candidate.
        // Rows without a reading (wty-ja-zh) join the same expression's reading group.
        let key = `${rec.expression}\u0000${reading}`;
        if (reading === '') {
          key = order.find((k) => k.startsWith(`${rec.expression}\u0000`)) ?? key;
        } else {
          const emptyKey = `${rec.expression}\u0000`;
          const eg = groups.get(emptyKey);
          if (eg && !groups.has(key)) {
            groups.delete(emptyKey);
            groups.set(key, { ...eg, reading });
            order[order.indexOf(emptyKey)] = key;
          }
        }
        const g = groups.get(key);
        if (g) {
          if (g.candidate === c && !g.records.includes(rec)) g.records.push(rec);
          continue;
        }
        groups.set(key, { candidate: c, lemma: rec.expression, reading, records: [rec] });
        order.push(key);
      }
    }
  }
  const scored = order.map((key, i) => {
    const g = groups.get(key)!;
    const best = Math.min(...g.records.map((r) => priorityOf(ctx, r.dictId)));
    const score = Math.max(...g.records.map((r) => r.score));
    return { g, i, best, score };
  });
  scored.sort(
    (a, b) =>
      b.g.candidate.matchedLength - a.g.candidate.matchedLength ||
      a.g.candidate.reasons.length - b.g.candidate.reasons.length ||
      a.best - b.best ||
      b.score - a.score ||
      a.i - b.i,
  );
  return scored.slice(0, limit).map(({ g }) => {
    const senseGroups: DictionarySenseGroup[] = [...g.records]
      .sort((a, b) => priorityOf(ctx, a.dictId) - priorityOf(ctx, b.dictId) || b.score - a.score || a.seq - b.seq)
      .map((r) => ({ dictId: r.dictId, dictTitle: ctx.dictionaries.get(r.dictId)?.title ?? r.dictId, expression: r.expression, reading: r.reading, defTags: r.defTags, senses: r.senses }));
    return {
      surface: g.candidate.surface,
      matchedLength: g.candidate.matchedLength,
      lemma: g.lemma,
      reading: g.reading,
      deinflectChain: [...g.candidate.reasons],
      pitches: lookupPitches(ctx, g.lemma, g.reading),
      frequencies: lookupFrequencies(ctx, g.lemma, g.reading),
      senseGroups,
    };
  });
}

/**
 * Full click-to-lookup over a host lookup source: scan prefixes, fetch every
 * distinct candidate term in ONE `findTerms` call, then redirect targets and
 * headword meta in one more round.
 */
export async function lookupPrefixBatch(text: string, source: DictionaryLookupSource, maxLength = 16, options: InstantLookupOptions = {}): Promise<InstantLookupMatch[]> {
  const usable = source.dictionaries.filter(isUsableDictionary);
  if (usable.length === 0 || text === '') return [];
  const candidates = scanPrefixDeinflections(text, maxLength);
  const keys = [...new Set(candidates.map((c) => c.term))];
  if (keys.length === 0) return [];
  const terms1 = await source.findTerms(keys);
  const have = new Set(keys);
  const redirects = new Set<string>();
  const heads = new Set<string>();
  for (const t of terms1) {
    heads.add(t.expression);
    if (t.redirectTo !== undefined) {
      heads.add(t.redirectTo);
      if (!have.has(t.redirectTo)) redirects.add(t.redirectTo);
    }
  }
  const [terms2, meta] = await Promise.all([redirects.size > 0 ? source.findTerms([...redirects]) : Promise.resolve([]), heads.size > 0 ? source.findMeta([...heads]) : Promise.resolve([])]);
  const ctx = buildEnrichContext(usable, [...terms1, ...terms2], meta);
  return buildInstantLookupMatches(candidates, ctx, options);
}
