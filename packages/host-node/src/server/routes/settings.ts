/** `/api/settings*` — SettingsApi (get / update / testAi). */
import type { Hono } from 'hono';
import type { ServerContext } from '../context';
import { mountGroup } from './api';

export function mountSettingsRoutes(app: Hono, ctx: ServerContext): void {
  mountGroup(app, ctx, 'settings');
}
