/**
 * `createApp(ctx)`: the Hono application — REST routes for every
 * `PlatformHost` group, SSE events, Range media, static `dist/web` with SPA
 * fallback. Binds nothing itself (see `main.ts`).
 */
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { API_PREFIX, INFO_PATH, okEnvelope } from '../shared';
import { rangeResponse } from '../media/range-stream';
import type { ServerContext } from './context';
import { localOnlyGuard } from './guard';
import { mountAiRoutes } from './routes/ai';
import { mountAnimeRoutes } from './routes/anime';
import { errorResponse } from './routes/api';
import { mountDownloadsRoutes } from './routes/downloads';
import { mountEventRoutes } from './routes/events';
import { mountFilesRoutes } from './routes/files';
import { mountMangaRoutes } from './routes/manga';
import { mountMediaRoutes } from './routes/media';
import { mountSettingsRoutes } from './routes/settings';

const STATIC_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();

  app.onError((error, c) => errorResponse(c, error));
  // Must run first: blocks DNS-rebinding hosts and cross-site writes.
  app.use('*', localOnlyGuard(ctx.options));

  app.get(INFO_PATH, (c) => c.json(okEnvelope(ctx.info)));
  app.get(`${API_PREFIX}/health`, (c) => c.json(okEnvelope({ status: 'ok' })));

  mountEventRoutes(app, ctx);
  mountMediaRoutes(app, ctx);
  mountSettingsRoutes(app, ctx);
  mountAnimeRoutes(app, ctx);
  mountMangaRoutes(app, ctx);
  mountAiRoutes(app, ctx);
  mountDownloadsRoutes(app, ctx);
  mountFilesRoutes(app, ctx);

  app.all(`${API_PREFIX}/*`, (c) => c.json({ ok: false, error: { code: 'not-found', message: `No route ${c.req.method} ${c.req.path}` } }, 404));

  const webDir = ctx.options.webDir ? resolve(ctx.options.webDir) : undefined;
  if (webDir) {
    // Static UI bundle with SPA fallback to index.html.
    app.get('*', async (c) => {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
      const candidate = resolve(webDir, rel);
      const inside = candidate === webDir || candidate.startsWith(webDir + sep);
      const target = inside && rel !== '' && (await isFile(candidate)) ? candidate : resolve(webDir, 'index.html');
      const res = await rangeResponse(c.req.raw, target, STATIC_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream');
      if (res.status === 200 && target.includes(`${sep}assets${sep}`)) res.headers.set('cache-control', 'public, max-age=31536000, immutable');
      return res;
    });
  } else {
    app.get('/', (c) => c.text('Kotori server is running. Start the UI with `pnpm dev:node` (Vite) or build it with `pnpm --filter @kotori/host-node build`.'));
  }
  return app;
}
