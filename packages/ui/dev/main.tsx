/** Dev harness entry: mounts the app against the MockPlatformHost. Owner: coder-3. */
import { mountKotoriApp } from '../src/index';
import { createMockPlatformHost } from '../src/host/mock-host';

const root = document.getElementById('root');
if (root) mountKotoriApp(root, createMockPlatformHost());
