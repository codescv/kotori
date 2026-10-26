/** WebView entry: mounts the shared UI with the Capacitor host. Owner: coder-2. */
import { mountKotoriApp } from '@kotori/ui';
import { createCapacitorPlatformHost } from '../src/index';

const root = document.getElementById('root');
if (root) {
  createCapacitorPlatformHost()
    .then((host) => {
      mountKotoriApp(root, host);
      window.addEventListener('pagehide', () => {
        void host.dispose();
      });
    })
    .catch((error: unknown) => {
      console.error('[kotori:host-android] failed to start', error);
      root.textContent = `Kotori failed to start: ${error instanceof Error ? error.message : String(error)}`;
    });
}
