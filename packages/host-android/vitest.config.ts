import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'host-android',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
