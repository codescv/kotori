/**
 * Binary media: `GET|HEAD /media/:episodeId` (HTTP Range video stream) and
 * `GET /api/manga/volumes/:volumeId/pages/:pageIndex/image` (page bytes).
 *
 * `/media/:episodeId` serves a cached ffmpeg MP4 remux instead of the original
 * file for `?compat=1` or Safari/iOS WebKit + `.mkv`/`.avi`/`.ts`
 * (`media/compat-remux.ts`), falling back to the original bytes when ffmpeg is
 * missing or the remux fails.
 */
import type { Context, Hono } from 'hono';
import { MANGA_IMAGE_PATH, MEDIA_PATH } from '../../shared';
import { createCompatRemuxer, wantsCompatRemux, type CompatRemuxer } from '../../media/compat-remux';
import { rangeResponse } from '../../media/range-stream';
import type { ServerContext } from '../context';
import { errorResponse } from './api';

export interface MediaRouteDeps {
  /** Compat remuxer (tests inject one with a fake ffmpeg runner). */
  readonly remuxer?: CompatRemuxer;
}

export function mountMediaRoutes(app: Hono, ctx: Pick<ServerContext, 'host' | 'ffmpeg'>, deps: MediaRouteDeps = {}): void {
  const remuxer =
    deps.remuxer ??
    createCompatRemuxer({
      ffmpeg: () => ctx.ffmpeg,
      onError: (error, filePath) => console.warn(`[kotori:media] compat remux failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`),
    });
  const media = async (c: Context): Promise<Response> => {
    try {
      const path = ctx.host.anime.mediaPath(c.req.param('episodeId') ?? '');
      if (remuxer.available() && wantsCompatRemux(path, c.req.url, c.req.header('user-agent'))) {
        const compat = await remuxer.remux(path);
        if (compat) return await rangeResponse(c.req.raw, compat, 'video/mp4');
      }
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
