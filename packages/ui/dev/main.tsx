/** Dev harness entry: mounts the app against the MockPlatformHost. Owner: coder-3. */
import { mountKotoriApp } from '../src/index';
import type { PlatformHost } from '@kotori/core';

// TODO(coder-3): `const host = createMockPlatformHost();`
const host: PlatformHost | undefined = undefined;
const root = document.getElementById('root');
if (root && host) mountKotoriApp(root, host);
