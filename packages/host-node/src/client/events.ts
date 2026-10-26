/**
 * Server-Sent Events client used for `HostEvent` push (`GET /api/events`) and
 * for streaming follow-up answers. Implemented on top of `fetch` +
 * `ReadableStream` (works in browsers, Node 22 and tests) with exponential
 * reconnect backoff. Browser-safe.
 */
import type { HostEvent, Unsubscribe } from '@kotori/core';
import type { FetchLike } from './http';

export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

/**
 * Incremental SSE parser: feed decoded text chunks, receive complete messages.
 * Handles `\n`, `\r\n` and `\r` line endings, multi-line `data:`, comments.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName = '';
  private lastId: string | undefined;

  constructor(private readonly onMessage: (message: SseMessage) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone trailing `\r` might be the first half of `\r\n`; wait for more.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  /** Flush a trailing message without terminating blank line (stream end). */
  end(): void {
    if (this.buffer.length > 0) {
      this.line(this.buffer);
      this.buffer = '';
    }
    this.line('');
  }

  private line(line: string): void {
    if (line === '') {
      if (this.dataLines.length > 0) {
        const msg: SseMessage = this.lastId === undefined
          ? { event: this.eventName || 'message', data: this.dataLines.join('\n') }
          : { event: this.eventName || 'message', data: this.dataLines.join('\n'), id: this.lastId };
        this.onMessage(msg);
      }
      this.dataLines = [];
      this.eventName = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    else if (field === 'id') this.lastId = value;
  }
}

/** Read an SSE `Response` body to completion, invoking `onMessage` per event. */
export async function readSseResponse(res: Response, onMessage: (message: SseMessage) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) throw new Error('SSE response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(onMessage);
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface EventStreamOptions {
  readonly url: string;
  readonly fetch: FetchLike;
  /** Initial reconnect delay (ms), doubled per failure up to `maxDelayMs`. */
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Notified when the connection state changes (for diagnostics / UI). */
  readonly onStatus?: (status: 'connecting' | 'open' | 'closed' | 'retrying') => void;
}

/**
 * One multiplexed SSE connection fanning `HostEvent`s out to N listeners. The
 * connection opens lazily on the first `subscribe` and closes when the last
 * listener unsubscribes (or on `close()`).
 */
export class HostEventStream {
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(private readonly options: EventStreamOptions) {}

  subscribe(listener: (event: HostEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && !this.controller && this.retryTimer === undefined) {
      this.closed = false;
      void this.connect();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  close(): void {
    this.listeners.clear();
    this.stop();
    this.closed = true;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private stop(): void {
    this.closed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.options.onStatus?.('closed');
  }

  private async connect(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.options.onStatus?.('connecting');
    try {
      const res = await this.options.fetch(this.options.url, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      this.attempt = 0;
      this.options.onStatus?.('open');
      await readSseResponse(res, (msg) => this.dispatch(msg), controller.signal);
    } catch {
      // fall through to reconnect
    }
    if (this.controller === controller) this.controller = undefined;
    if (this.closed || controller.signal.aborted || this.listeners.size === 0) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const initial = this.options.initialDelayMs ?? 500;
    const max = this.options.maxDelayMs ?? 15_000;
    const delay = Math.min(max, initial * 2 ** this.attempt);
    this.attempt += 1;
    this.options.onStatus?.('retrying');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.closed && this.listeners.size > 0) void this.connect();
    }, delay);
  }

  private dispatch(msg: SseMessage): void {
    if (msg.event !== 'message' && msg.event !== 'host-event') return;
    let event: HostEvent;
    try {
      event = JSON.parse(msg.data) as HostEvent;
    } catch {
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[kotori:events] listener failed', error);
      }
    }
  }
}
