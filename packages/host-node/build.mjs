// Bundles the server (and @kotori/core) into a single ESM file so end users
// only need `node`. Dev-time only dependency on esbuild.
import { cpSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Pure-JS deps are bundled; node built-ins stay external automatically.
  banner: { js: "import { createRequire as __kotoriCreateRequire } from 'node:module'; const require = __kotoriCreateRequire(import.meta.url);" },
  logLevel: 'info',
});

// SQL migrations are read at runtime relative to the bundle (`dist/migrations/`).
mkdirSync('dist/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
