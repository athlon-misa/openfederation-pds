import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/api/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    setupFiles: ['tests/api/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run tests sequentially — they share a database
    sequence: { concurrent: false },
    fileParallelism: false,
  },
  resolve: {
    // Exact package names → their source, so tests don't depend on a built
    // dist/ (CI builds neither package before the tests).
    alias: [
      { find: /^@open-federation\/pseudonym$/, replacement: resolve(__dirname, 'packages/openfederation-pseudonym/src/index.ts') },
      { find: /^@open-federation\/sdk\/custody$/, replacement: resolve(__dirname, 'packages/openfederation-sdk/src/custody/index.ts') },
      { find: '@', replacement: resolve(__dirname, 'src') },
    ],
  },
});
