/**
 * `/api/anime/*` — AnimeApi. Adds the multipart variant of
 * `POST /api/anime/episodes/:episodeId/tracks` (browser file picker upload)
 * and the series cover image.
 */
import type { Hono } from 'hono';
import { KotoriError, decodeSubtitleBytes } from '@kotori/core';
import { ROUTES, okEnvelope } from '../../shared';
import { rangeResponse } from '../../media/range-stream';
import type { ServerContext } from '../context';
import { errorResponse, invoke, mountGroup, wireRequest } from './api';

export function mountAnimeRoutes(app: Hono, ctx: ServerContext): void {
  const add = ROUTES['anime.addSubtitleTrack'];
  // Registered before the generic route: handles both multipart and JSON.
  app.post(add.path, async (c) => {
    try {
      const contentType = c.req.header('content-type') ?? '';
      if (!contentType.startsWith('multipart/form-data')) {
        const wire = await wireRequest(c, 'POST');
        return c.json(okEnvelope(await invoke(ctx, 'anime.addSubtitleTrack', wire)));
      }
      const form = await c.req.parseBody();
      const file = form['file'];
      if (!(file instanceof File)) throw new KotoriError('invalid-argument', 'multipart field "file" is required');
      const { text } = decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer()));
      const fileName = typeof form['fileName'] === 'string' && form['fileName'] ? form['fileName'] : file.name;
      const language = typeof form['language'] === 'string' && form['language'] ? form['language'] : undefined;
      const episodeId = c.req.param('episodeId') ?? '';
      const track = await ctx.host.anime.addSubtitleTrack(episodeId, { content: text, fileName, ...(language ? { language } : {}) });
      return c.json(okEnvelope(track));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get('/api/anime/series/:seriesId/cover', async (c) => {
    const path = ctx.host.anime.coverPath(c.req.param('seriesId'));
    if (!path) return c.body(null, 404);
    return rangeResponse(c.req.raw, path);
  });

  mountGroup(app, ctx, 'anime', new Set(['anime.addSubtitleTrack']));
}
