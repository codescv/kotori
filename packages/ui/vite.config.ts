import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Standalone dev harness: `pnpm dev:ui` runs the app against MockPlatformHost. */
export default defineConfig({
  root: 'dev',
  plugins: [react()],
  server: { port: 5174 },
  build: { outDir: '../dist-dev', emptyOutDir: true },
});
