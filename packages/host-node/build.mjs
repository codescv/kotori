// Bundles the server (and @kotori/core) into a single ESM file so end users
// only need `node`. Dev-time only dependency on esbuild.
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
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
