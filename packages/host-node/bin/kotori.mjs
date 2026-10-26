#!/usr/bin/env node
// Runtime entry for macOS / Linux: runs the esbuild-bundled server (dist/server.mjs)
// with plain `node` — no TypeScript toolchain, no native addons at runtime.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundled = new URL('../dist/server.mjs', import.meta.url);
if (!existsSync(fileURLToPath(bundled))) {
  console.error('[kotori] dist/server.mjs missing — run `pnpm --filter @kotori/host-node build` first.');
  process.exit(1);
}
await import(bundled.href);
