import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without `globals`, so Testing Library cannot register its own
// automatic cleanup; unmount rendered trees after every test explicitly.
afterEach(() => {
  cleanup();
});

// jsdom has no media pipeline: make play()/pause() inert instead of logging
// "Not implemented" errors (the player then runs on its own clock).
Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => {} });
Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
