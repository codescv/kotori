#!/usr/bin/env node
// Runtime entry for macOS / Linux: runs the esbuild-bundled server (dist/server.mjs)
// with plain `node` — no TypeScript toolchain, no native addons at runtime.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` on
// the first `node:sqlite` import. Swallow exactly that warning and keep every
// other warning's default stderr output.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener.call(process, warning);
});

const bundled = new URL('../dist/server.mjs', import.meta.url);
const webIndex = new URL('../dist/web/index.html', import.meta.url);
if (!existsSync(fileURLToPath(bundled)) || !existsSync(fileURLToPath(webIndex))) {
  console.log('[kotori] dist bundle not found — building UI and server bundle first…');
  const { execSync } = await import('node:child_process');
  const pkgDir = fileURLToPath(new URL('..', import.meta.url));
  execSync('pnpm run build', { cwd: pkgDir, stdio: 'inherit' });
}
await import(bundled.href);
