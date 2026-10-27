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
  plugins: {
    // Patch window.fetch/XHR to go through the native HTTP stack so Gemini,
    // Jimaku, mokuro.moe and Nyaa are reachable from the WebView without CORS.
    CapacitorHttp: { enabled: true },
    // Disable Capacitor's default SystemBars DecorView padding on WebView < 140
    // so MainActivity can keep the WebView 100% edge-to-edge full-screen and
    // expose safe-area insets via --k-safe-* CSS variables.
    SystemBars: { insetsHandling: 'disable' },
  },
};

export default config;
