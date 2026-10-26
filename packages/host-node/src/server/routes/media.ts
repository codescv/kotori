/**
 * Binary media: `GET|HEAD /media/:episodeId` (HTTP Range video stream) and
 * `GET /api/manga/volumes/:volumeId/pages/:pageIndex/image` (page bytes).
 */
import type { Context, Hono } from 'hono';
import { MANGA_IMAGE_PATH, MEDIA_PATH } from '../../shared';
import { rangeResponse } from '../../media/range-stream';
import type { ServerContext } from '../context';
import { errorResponse } from './api';

export function mountMediaRoutes(app: Hono, ctx: ServerContext): void {
  const media = async (c: Context): Promise<Response> => {
    try {
      const path = ctx.host.anime.mediaPath(c.req.param('episodeId') ?? '');
      return await rangeResponse(c.req.raw, path);
    } catch (error) {
      return errorResponse(c, error);
    }
  };
  app.on(['GET', 'HEAD'], MEDIA_PATH, media);

  app.on(['GET', 'HEAD'], MANGA_IMAGE_PATH, async (c) => {
    try {
      const pageIndex = Number(c.req.param('pageIndex'));
      const path = ctx.host.manga.imagePath(c.req.param('volumeId') ?? '', pageIndex);
      const res = await rangeResponse(c.req.raw, path);
      // Page images are immutable per volume import.
      if (res.status === 200) res.headers.set('cache-control', 'private, max-age=86400');
      return res;
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
