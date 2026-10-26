/** `/api/manga/*` — MangaApi (page images are served by `media.ts`). */
import type { Hono } from 'hono';
import type { ServerContext } from '../context';
import { mountGroup } from './api';

export function mountMangaRoutes(app: Hono, ctx: ServerContext): void {
  mountGroup(app, ctx, 'manga');
}
