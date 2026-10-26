import { describe, expect, it, vi } from 'vitest';
import { KotoriError } from '@kotori/core';
import type { FollowUpDelta, HostEvent, PlatformHost } from '@kotori/core';
import { ROUTES, ROUTE_KEYS, buildPath, buildQuery, type RoutedMethodKey, type WireRequest } from '../shared';
import { SAMPLE_ARGS } from '../shared/sample-args.testutil';
import { connectRestPlatformHost, createRestPlatformHost, DEFAULT_DESKTOP_CAPABILITIES } from './rest-host';
import { HostEventStream, SseParser, type SseMessage } from './events';

interface Call {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | undefined;
}

function recordingFetch(respond: (call: Call) => Response = () => Response.json({ ok: true, data: null })) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return { fetch, calls };
}

/** Invoke `host[group][method](...args)` for a route key. */
function callHost(host: PlatformHost, key: RoutedMethodKey, args: readonly unknown[]): Promise<unknown> {
  const [group, method] = key.split('.') as [keyof PlatformHost, string];
  const target = host[group] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const fn = target[method];
  if (!fn) throw new Error(`missing ${key}`);
  // followUpStream needs an onDelta callback in position 2.
  return key === 'ai.followUpStream' ? fn(args[0], () => undefined) : fn(...args);
}

describe('createRestPlatformHost', () => {
  it('sends the route-table method/URL/body for every PlatformHost method', async () => {
    const { fetch, calls } = recordingFetch((call) =>
      call.url.endsWith('/api/ai/follow-up/stream')
        ? new Response('event: done\ndata: {"id":"m1","role":"model","text":"ok","createdAt":1}\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ ok: true, data: null }),
    );
    const host = createRestPlatformHost({ baseUrl: 'http://127.0.0.1:7865/', fetch });
    for (const key of ROUTE_KEYS) {
      const args = SAMPLE_ARGS[key] as readonly unknown[];
      await callHost(host, key, args);
      const call = calls.at(-1);
      const route = ROUTES[key];
      const wire = (route.encode as (...a: unknown[]) => WireRequest)(...args);
      expect(call?.method, key).toBe(route.method);
      expect(call?.url, key).toBe(`http://127.0.0.1:7865${buildPath(route.path, wire.params)}${buildQuery(wire.query)}`);
      expect(call?.body, key).toEqual(wire.body === undefined ? undefined : JSON.parse(JSON.stringify(wire.body)));
    }
    expect(calls).toHaveLength(ROUTE_KEYS.length);
  });

  it('has no native pickers on desktop and exposes default capabilities', () => {
    const host = createRestPlatformHost({ fetch: async () => Response.json({}) });
    expect(host.files.pickDirectory).toBeUndefined();
    expect(host.files.pickFiles).toBeUndefined();
    expect(host.info.capabilities).toEqual(DEFAULT_DESKTOP_CAPABILITIES);
    expect(typeof host.ai.followUpStream).toBe('function');
  });

  it('fetches /api/info on connect', async () => {
    const info = { platform: 'node', os: 'linux', version: '0.1.0', dataDir: '/d', capabilities: { ...DEFAULT_DESKTOP_CAPABILITIES, embeddedSubtitles: true } };
    const { fetch, calls } = recordingFetch(() => Response.json({ ok: true, data: info }));
    const host = await connectRestPlatformHost({ baseUrl: 'http://h', fetch });
    expect(calls[0]?.url).toBe('http://h/api/info');
    expect(host.info).toEqual(info);
  });

  it('decodes data, maps null to undefined and rebuilds KotoriError', async () => {
    const responses = [
      Response.json({ ok: true, data: [{ id: 'sr_1' }] }),
      Response.json({ ok: true, data: null }),
      Response.json({ ok: false, error: { code: 'not-found', message: 'nope', details: { id: 'x' } } }, { status: 404 }),
      new Response('<html>bad gateway</html>', { status: 502 }),
    ];
    const host = createRestPlatformHost({ baseUrl: '', fetch: async () => responses.shift() ?? Response.json({}) });
    await expect(host.anime.listSeries()).resolves.toEqual([{ id: 'sr_1' }]);
    await expect(host.ai.getCachedExplanation(SAMPLE_ARGS['ai.explain'][0])).resolves.toBeUndefined();
    const err = await host.anime.getSeries('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KotoriError);
    expect((err as KotoriError).code).toBe('not-found');
    expect((err as KotoriError).details).toEqual({ id: 'x' });
    await expect(host.anime.listSeries()).rejects.toMatchObject({ code: 'internal' });
  });

  it('maps network failures and aborts to KotoriError codes', async () => {
    const host = createRestPlatformHost({
      baseUrl: '',
      fetch: async (_url, init) => {
        if (init?.signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        throw new TypeError('connection refused');
      },
    });
    await expect(host.settings.get()).rejects.toMatchObject({ code: 'network' });
    const controller = new AbortController();
    controller.abort();
    await expect(host.ai.explain(SAMPLE_ARGS['ai.explain'][0], { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('aborts in-flight AI calls through the caller signal', async () => {
    let seen: AbortSignal | undefined;
    const host = createRestPlatformHost({
      baseUrl: '',
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    });
    const controller = new AbortController();
    const pending = host.ai.explain(SAMPLE_ARGS['ai.explain'][0], { signal: controller.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen?.aborted).toBe(true);
  });

  it('streams follow-up deltas and resolves with the final message', async () => {
    const body = [
      'data: {"messageId":"m1","textDelta":"こん","done":false}\n\n',
      'data: {"messageId":"m1","textDelta":"にちは","done":false}\r\n\r\n',
      'data: {"messageId":"m1","textDelta":"","done":true}\n\n',
      'event: done\ndata: {"id":"m1","role":"model","text":"こんにちは","createdAt":5}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of body) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    const host = createRestPlatformHost({ baseUrl: '', fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
    const deltas: FollowUpDelta[] = [];
    const msg = await host.ai.followUpStream?.(SAMPLE_ARGS['ai.followUp'][0], (d) => deltas.push(d));
    expect(deltas.map((d) => d.textDelta).join('')).toBe('こんにちは');
    expect(deltas.at(-1)?.done).toBe(true);
    expect(msg).toMatchObject({ id: 'm1', text: 'こんにちは' });
  });

  it('rejects follow-up streams that report an error event or a JSON error', async () => {
    const sse = 'event: error\ndata: {"code":"ai-quota","message":"429"}\n\n';
    const host = createRestPlatformHost({ baseUrl: '', fetch: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) });
    await expect(host.ai.followUpStream?.(SAMPLE_ARGS['ai.followUp'][0], () => undefined)).rejects.toMatchObject({ code: 'ai-quota' });
    const host2 = createRestPlatformHost({ baseUrl: '', fetch: async () => Response.json({ ok: false, error: { code: 'not-found', message: 'gone' } }, { status: 404 }) });
    await expect(host2.ai.followUpStream?.(SAMPLE_ARGS['ai.followUp'][0], () => undefined)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('SseParser', () => {
  it('parses multi-line data, events, ids, comments and split chunks', () => {
    const out: SseMessage[] = [];
    const p = new SseParser((m) => out.push(m));
    p.push(': hello\n\nevent: done\nid: 7\ndata: a\nda');
    p.push('ta: b\n\ndata: x\r');
    p.push('\n\r\ndata:no-space\n');
    p.end();
    expect(out).toEqual([
      { event: 'done', data: 'a\nb', id: '7' },
      { event: 'message', data: 'x', id: '7' },
      { event: 'message', data: 'no-space', id: '7' },
    ]);
  });
});

describe('HostEventStream', () => {
  it('fans events out to listeners, reconnects with backoff and stops when unsubscribed', async () => {
    vi.useFakeTimers();
    try {
      const event: HostEvent = { type: 'library-changed', scope: 'anime' };
      let connects = 0;
      const fetch = vi.fn(async () => {
        connects += 1;
        if (connects === 1) throw new TypeError('offline');
        return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      });
      const statuses: string[] = [];
      const stream = new HostEventStream({ url: 'http://h/api/events', fetch, initialDelayMs: 100, maxDelayMs: 1000, onStatus: (s) => statuses.push(s) });
      const a: HostEvent[] = [];
      const b: HostEvent[] = [];
      const unA = stream.subscribe((e) => a.push(e));
      const unB = stream.subscribe((e) => b.push(e));
      await vi.advanceTimersByTimeAsync(0);
      expect(connects).toBe(1);
      expect(statuses).toContain('retrying');
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(a).toEqual([event]));
      expect(b).toEqual([event]);
      expect(fetch).toHaveBeenCalledTimes(2);
      unA();
      unB();
      expect(stream.listenerCount).toBe(0);
      const before = fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetch.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores malformed payloads and isolates listener errors', async () => {
    const good: HostEvent = { type: 'download-removed', taskId: 't' };
    const body = `data: not json\n\ndata: ${JSON.stringify(good)}\n\n`;
    const stream = new HostEventStream({ url: 'u', fetch: async () => new Response(body), initialDelayMs: 10_000 });
    const got: HostEvent[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stream.subscribe(() => {
      throw new Error('listener bug');
    });
    stream.subscribe((e) => got.push(e));
    await vi.waitFor(() => expect(got).toEqual([good]));
    stream.close();
    errSpy.mockRestore();
  });
});
