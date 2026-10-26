import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Builds the desktop web bundle into `packages/host-node/dist/web`, served by the
 * Node server as static files. In `pnpm dev:node`, Vite proxies `/api` to the
 * running server so the UI hot-reloads against real data.
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7865',
      '/media': 'http://127.0.0.1:7865',
    },
  },
});
