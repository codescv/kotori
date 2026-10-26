/** `/api/files/*` — server-side path browser + `openExternal`. */
import type { Hono } from 'hono';
import type { ServerContext } from '../context';
import { mountGroup } from './api';

export function mountFilesRoutes(app: Hono, ctx: ServerContext): void {
  mountGroup(app, ctx, 'files');
}
