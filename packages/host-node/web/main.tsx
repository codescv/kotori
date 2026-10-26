/**
 * Browser entry for the desktop host: mounts the shared UI with the REST host.
 * Owner: coder-2 (wiring only; all components live in @kotori/ui).
 */
import { mountKotoriApp } from '@kotori/ui';
import { connectRestPlatformHost, createRestPlatformHost } from '../src/client';

const root = document.getElementById('root');
if (root) {
  // Fetch /api/info first so capabilities (ffmpeg, torrent, …) are accurate;
  // fall back to defaults if the server is momentarily unreachable.
  connectRestPlatformHost()
    .catch(() => createRestPlatformHost())
    .then((host) => mountKotoriApp(root, host));
}
