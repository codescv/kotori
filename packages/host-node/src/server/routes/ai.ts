/**
 * `/api/ai/*` — AiApi. `POST /api/ai/follow-up/stream` answers with
 * Server-Sent Events: default events carry `FollowUpDelta`, then
 * `event: done` (final `FollowUpMessage`) or `event: error` (`KotoriErrorShape`).
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { FollowUpRequest } from '@kotori/core';
import { ROUTES, serialiseError } from '../../shared';
import type { ServerContext } from '../context';
import { errorResponse, mountGroup, readJsonBody } from './api';

export function mountAiRoutes(app: Hono, ctx: ServerContext): void {
  const route = ROUTES['ai.followUpStream'];
  app.post(route.path, async (c) => {
    let request: FollowUpRequest;
    try {
      [request] = route.decode({ params: {}, query: {}, body: await readJsonBody(c) });
    } catch (error) {
      return errorResponse(c, error);
    }
    const signal = c.req.raw.signal;
    return streamSSE(c, async (stream) => {
      // Deltas arrive synchronously; serialise writes through a promise chain.
      let chain: Promise<void> = Promise.resolve();
      const write = (event: string | undefined, data: unknown): Promise<void> => {
        chain = chain.then(() => (event ? stream.writeSSE({ event, data: JSON.stringify(data) }) : stream.writeSSE({ data: JSON.stringify(data) })));
        return chain;
      };
      try {
        const message = await ctx.host.ai.followUpStream(request, (delta) => void write(undefined, delta), { signal });
        await write('done', message);
      } catch (error) {
        await write('error', serialiseError(error));
      }
    });
  });
  mountGroup(app, ctx, 'ai', new Set(['ai.followUpStream']));
}
