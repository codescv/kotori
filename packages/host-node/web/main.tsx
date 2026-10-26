/**
 * Browser entry for the desktop host: mounts the shared UI with the REST host.
 * Owner: coder-2 (wiring only; all components live in @kotori/ui).
 */
import { mountKotoriApp } from '@kotori/ui';
import type { PlatformHost } from '@kotori/core';

// TODO(coder-2): replace with `createRestPlatformHost()` from '../src/client'.
const host: PlatformHost | undefined = undefined;

const root = document.getElementById('root');
if (root && host) {
  mountKotoriApp(root, host);
}
