/** `GET /api/events` — Server-Sent Events stream of `HostEvent`s with heartbeats. */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { HostEvent } from '@kotori/core';
import { EVENTS_PATH } from '../../shared';
import type { ServerContext } from '../context';

export const HEARTBEAT_MS = 15_000;

export function mountEventRoutes(app: Hono, ctx: ServerContext): void {
  app.get(EVENTS_PATH, (c) =>
    streamSSE(c, async (stream) => {
      const queue: HostEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = ctx.events.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        await stream.write('retry: 2000\n\n');
        await stream.write(': connected\n\n');
        while (open && !stream.aborted) {
          const event = queue.shift();
          if (event) {
            await stream.writeSSE({ data: JSON.stringify(event) });
            continue;
          }
          // Wait for the next event or the heartbeat tick.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, HEARTBEAT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
          if (queue.length === 0 && open) await stream.write(': ping\n\n');
        }
      } finally {
        unsubscribe();
      }
    }),
  );
}
