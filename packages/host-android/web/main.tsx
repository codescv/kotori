/** WebView entry: mounts the shared UI with the Capacitor host. Owner: coder-2. */
import { mountKotoriApp } from '@kotori/ui';
import type { PlatformHost } from '@kotori/core';

// TODO(coder-2): `const host = await createCapacitorPlatformHost();`
const host: PlatformHost | undefined = undefined;
const root = document.getElementById('root');
if (root && host) mountKotoriApp(root, host);
