/**
 * CLI entry: `kotori [--port 7865] [--host 127.0.0.1] [--data-dir ~/.kotori] [--web-dir dir] [--no-open] [--dev]`.
 * Starts the local server and opens the UI in a Chrome/Chromium/Edge
 * `--app=` window when available (standalone feel), else the default browser.
 * Owner: coder-2.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, type ServerOptions } from './index';
import { startServer } from './start';
import { systemOpener } from './services/downloads';

export function parseArgs(argv: readonly string[]): ServerOptions & { readonly dev: boolean } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    return eq?.slice(flag.length + 1);
  };
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  const dev = argv.includes('--dev');
  const webDir = get('--web-dir') ?? (dev ? undefined : defaultWebDir());
  return {
    host: get('--host') ?? '127.0.0.1',
    port: Number(get('--port') ?? process.env['KOTORI_PORT'] ?? DEFAULT_PORT),
    dataDir: get('--data-dir') ?? process.env['KOTORI_DATA_DIR'] ?? `${home}/.kotori`,
    openBrowser: !argv.includes('--no-open') && !dev,
    dev,
    ...(webDir ? { webDir } : {}),
  };
}

/** `dist/web` next to the bundled `dist/server.mjs`, or `../../dist/web` from source. */
function defaultWebDir(): string | undefined {
  for (const rel of ['./web/', '../../dist/web/']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

const CHROME_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'],
};

function onPath(bin: string): string | undefined {
  if (bin.startsWith('/')) return existsSync(bin) ? bin : undefined;
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const full = join(dir, bin);
    if (dir && existsSync(full)) return full;
  }
  return undefined;
}

/** Open `url` as a Chromium app window, falling back to the default browser. */
export async function openBrowser(url: string, dataDir: string): Promise<void> {
  for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
    const bin = onPath(candidate);
    if (!bin) continue;
    const child = spawn(bin, [`--app=${url}`, `--user-data-dir=${join(dataDir, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => undefined);
    child.unref();
    return;
  }
  await systemOpener(url).catch((error: unknown) => console.warn('[kotori] could not open a browser:', error instanceof Error ? error.message : error));
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const server = await startServer(options);
  console.log(`[kotori] listening on ${server.url} (data: ${options.dataDir})`);
  if (!options.webDir && !options.dev) console.warn('[kotori] UI bundle not found — run `pnpm --filter @kotori/host-node build` (serving API only).');
  if (!server.ctx.ffmpeg) console.log('[kotori] ffmpeg not found: embedded MKV subtitle extraction disabled.');
  if (options.openBrowser) await openBrowser(server.url, options.dataDir);
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[kotori] ${signal} received, shutting down…`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

/** Run when executed directly (tsx / bundled `dist/server.mjs` via `bin/kotori.mjs`). */
const entry = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
const isBundle = import.meta.url.endsWith('/dist/server.mjs');
if (isBundle || import.meta.url === entry || entry.endsWith('/src/server/main.ts')) {
  main().catch((error: unknown) => {
    console.error('[kotori] failed to start:', error);
    process.exit(1);
  });
}
