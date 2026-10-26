/** Bind the Hono app to `127.0.0.1:{port}` with `@hono/node-server` (port fallback on EADDRINUSE). */
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './app';
import { createServerContext, type ContextOverrides, type ServerContext } from './context';
import type { ServerOptions } from './index';

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly ctx: ServerContext;
  close(): Promise<void>;
}

function listen(app: ReturnType<typeof createApp>, hostname: string, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port }, () => resolve(server));
    server.once('error', reject);
  });
}

/** Create the context, mount the app and listen; tries up to 10 successive ports. */
export async function startServer(options: ServerOptions, overrides: ContextOverrides = {}): Promise<RunningServer> {
  const ctx = await createServerContext(options, overrides);
  const app = createApp(ctx);
  let server: ServerType | undefined;
  let lastError: unknown;
  const attempts = options.port === 0 ? 1 : 10;
  for (let i = 0; i < attempts && !server; i++) {
    try {
      server = await listen(app, options.host, options.port === 0 ? 0 : options.port + i);
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
    }
  }
  if (!server) {
    await ctx.close();
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  const port = (server.address() as AddressInfo).port;
  const bound = server;
  return {
    url: `http://${options.host}:${port}`,
    port,
    ctx,
    async close() {
      await new Promise<void>((resolve) => {
        // Long-lived SSE connections would keep `close` pending forever.
        (bound as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        bound.close(() => resolve());
      });
      await ctx.close();
    },
  };
}
