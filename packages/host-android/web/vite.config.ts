import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = fileURLToPath(new URL('../../ui/public', import.meta.url));

/** Builds the Capacitor `webDir` (packages/host-android/www). */
export default defineConfig({
  root: here,
  publicDir,
  plugins: [react()],
  build: {
    outDir: '../www',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: { port: 5175 },
});
