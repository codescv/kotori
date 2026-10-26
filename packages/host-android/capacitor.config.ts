import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.kotori.app',
  appName: 'Kotori',
  // Output of `vite build web` (see web/vite.config.ts).
  webDir: 'www',
  android: {
    allowMixedContent: false,
    // Needed so <video>/<img> can load large local files via convertFileSrc.
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
