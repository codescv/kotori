/** `/api/downloads/*` — DownloadsApi (Nyaa / Jimaku / mokuro.moe discovery + task control). */
import type { Hono } from 'hono';
import type { ServerContext } from '../context';
import { mountGroup } from './api';

export function mountDownloadsRoutes(app: Hono, ctx: ServerContext): void {
  mountGroup(app, ctx, 'downloads');
}
