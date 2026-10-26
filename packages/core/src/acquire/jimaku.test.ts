import { describe, expect, it } from 'vitest';
import type { JimakuFile, ParsedEpisodeName } from '../types';
import { createJimakuClient, mapJimakuEntry, mapJimakuFile, matchJimakuFilesToEpisodes } from './jimaku';
import { KotoriError } from '../util/errors';

// `types: []` keeps node typings out of core; load fixtures via an untyped dynamic import.
const NODE_FS = 'node:fs';
async function fixture(name: string): Promise<string> {
  const fs = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync(p: URL, enc: 'utf8'): string };
  return fs.readFileSync(new URL(`../../test-fixtures/acquire/${name}`, import.meta.url), 'utf8');
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Fake fetch recording calls and replying with the given response factory. */
function fakeFetch(reply: (url: string) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return reply(url);
  }) as typeof fetch;
  return { fetch: f, calls };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

async function rejection(p: Promise<unknown>): Promise<KotoriError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KotoriError);
    return e as KotoriError;
  }
  throw new Error('expected rejection');
}

describe('mapJimakuEntry', () => {
  it('maps the real API shape and drops nulls', async () => {
    const raw = JSON.parse(await fixture('jimaku-entries.json')) as unknown[];
    expect(mapJimakuEntry(raw[0])).toEqual({
      id: 3127,
      name: 'Sousou no Frieren',
      japaneseName: '葬送のフリーレン',
      englishName: "Frieren: Beyond Journey's End",
      anilistId: 154587,
      tmdbId: 'tv:209867',
      flags: { anime: true, unverified: false, external: false, movie: false, adult: false },
      lastModifiedAt: Date.parse('2024-03-23T12:34:56.789012Z'),
    });
    const second = mapJimakuEntry(raw[1]);
    expect(second).toMatchObject({ id: 4410, flags: { unverified: true } });
    expect(second && 'englishName' in second).toBe(false);
    expect(second && 'anilistId' in second).toBe(false);
    expect(mapJimakuEntry(raw[2])).toBeUndefined();
    expect(mapJimakuEntry(null)).toBeUndefined();
  });
});

describe('mapJimakuFile', () => {
  it('derives extension, archive format and episode', async () => {
    const raw = JSON.parse(await fixture('jimaku-files.json')) as unknown[];
    expect(mapJimakuFile(raw[0], 3127)).toEqual({
      entryId: 3127,
      name: '葬送のフリーレン.S01E01.WEBRip.Netflix.ja[cc].srt',
      url: 'https://jimaku.cc/entry/3127/download/%E8%91%AC%E9%80%81%E3%81%AE%E3%83%95%E3%83%AA%E3%83%BC%E3%83%AC%E3%83%B3.S01E01.WEBRip.Netflix.ja%5Bcc%5D.srt',
      sizeBytes: 45231,
      lastModifiedAt: Date.parse('2023-10-01T10:00:00Z'),
      extension: 'srt',
      isTextSubtitle: true,
      episode: 1,
    });
    const zip = mapJimakuFile(raw[6], 3127);
    expect(zip).toMatchObject({ extension: 'zip', archiveFormat: 'zip', isTextSubtitle: false });
    expect(zip && 'episode' in zip).toBe(false);
    expect(mapJimakuFile(raw[4], 3127)?.episode).toBe(3);
    expect(mapJimakuFile({ name: 'x.srt' }, 1)).toBeUndefined();
  });
});

describe('createJimakuClient', () => {
  it('searchEntries sends the API key and query params, maps the result', async () => {
    const entries = JSON.parse(await fixture('jimaku-entries.json')) as unknown;
    const { fetch, calls } = fakeFetch(() => json(entries));
    const client = createJimakuClient({ fetch, apiKey: 'KEY123', baseUrl: 'https://jimaku.example/' });
    const out = await client.searchEntries({ query: '葬送のフリーレン', anilistId: 154587 });
    expect(out.map((e) => e.id)).toEqual([3127, 4410]);
    expect(calls[0]?.url).toBe(`https://jimaku.example/api/entries/search?query=${encodeURIComponent('葬送のフリーレン')}&anilist_id=154587`);
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('KEY123');
    expect(await client.searchEntries({})).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('listFiles hits /files with the optional episode', async () => {
    const files = JSON.parse(await fixture('jimaku-files.json')) as unknown;
    const { fetch, calls } = fakeFetch(() => json(files));
    const client = createJimakuClient({ fetch, apiKey: 'k' });
    const out = await client.listFiles(3127, 2);
    expect(calls[0]?.url).toBe('https://jimaku.cc/api/entries/3127/files?episode=2');
    expect(out).toHaveLength(7);
    expect(out.every((f) => f.entryId === 3127)).toBe(true);
    await client.listFiles(3127);
    expect(calls[1]?.url).toBe('https://jimaku.cc/api/entries/3127/files');
  });

  it('maps HTTP failures to KotoriError codes', async () => {
    const rate = createJimakuClient({
      apiKey: 'k',
      fetch: fakeFetch(() => json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } })).fetch,
    });
    const e429 = await rejection(rate.listFiles(1));
    expect(e429.code).toBe('network');
    expect(e429.details).toMatchObject({ status: 429, retryAfterMs: 3000 });
    expect(e429.message).toContain('slow down');

    const reset = createJimakuClient({
      apiKey: 'k',
      fetch: fakeFetch(() => new Response('', { status: 429, headers: { 'x-ratelimit-reset-after': '1.5' } })).fetch,
    });
    expect((await rejection(reset.listFiles(1))).details).toMatchObject({ retryAfterMs: 1500 });

    const auth = createJimakuClient({ apiKey: 'bad', fetch: fakeFetch(() => json({ error: 'unauthorized' }, { status: 401 })).fetch });
    const e401 = await rejection(auth.searchEntries({ query: 'x' }));
    expect(e401.code).toBe('network');
    expect(e401.details).toMatchObject({ status: 401 });

    const missing = createJimakuClient({ apiKey: 'k', fetch: fakeFetch(() => new Response('nope', { status: 404 })).fetch });
    expect((await rejection(missing.listFiles(999))).code).toBe('not-found');

    const garbage = createJimakuClient({ apiKey: 'k', fetch: fakeFetch(() => new Response('<html>', { status: 200 })).fetch });
    expect((await rejection(garbage.listFiles(1))).code).toBe('parse');

    const noKey = createJimakuClient({ apiKey: '  ', fetch: fakeFetch(() => json([])).fetch });
    expect((await rejection(noKey.listFiles(1))).code).toBe('invalid-argument');
  });

  it('maps transport errors and aborts', async () => {
    const down = createJimakuClient({
      apiKey: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect((await rejection(down.listFiles(1))).code).toBe('network');

    const ac = new AbortController();
    ac.abort();
    const aborted = createJimakuClient({
      apiKey: 'k',
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return json([]);
      }) as typeof fetch,
    });
    expect((await rejection(aborted.listFiles(1, undefined, { signal: ac.signal }))).code).toBe('cancelled');
  });
});

describe('matchJimakuFilesToEpisodes', () => {
  const ep = (id: string, episode: number | undefined, season?: number) => {
    const parsedName: ParsedEpisodeName = {
      raw: id,
      title: 'Sousou no Frieren',
      isBatch: false,
      ...(episode === undefined ? {} : { episode }),
      ...(season === undefined ? {} : { season }),
    };
    return { id, parsedName };
  };

  it('prefers .ass > .srt > .vtt, then newest, and skips archives', async () => {
    const raw = JSON.parse(await fixture('jimaku-files.json')) as unknown[];
    const files = raw.map((f) => mapJimakuFile(f, 3127)).filter((f): f is JimakuFile => f !== undefined);
    const m = matchJimakuFilesToEpisodes(files, [ep('e1', 1), ep('e2', 2), ep('e3', 3), ep('e4', 4), ep('ex', undefined)]);
    expect(m.get('e1')?.name).toBe('[Kitsunekko] Sousou no Frieren - 01.ass');
    expect(m.get('e2')?.name).toBe('Sousou no Frieren - 02.srt');
    expect(m.get('e3')?.name).toBe('葬送のフリーレン 第03話 v2.srt');
    expect(m.has('e4')).toBe(false);
    expect(m.has('ex')).toBe(false);
  });

  it('skips files whose season disagrees', () => {
    const files = [
      mapJimakuFile({ url: 'u1', name: 'Show S02E01.srt' }, 1),
      mapJimakuFile({ url: 'u2', name: 'Show S01E01.srt' }, 1),
    ].filter((f): f is JimakuFile => f !== undefined);
    expect(matchJimakuFilesToEpisodes(files, [ep('a', 1, 1)]).get('a')?.url).toBe('u2');
  });
});
