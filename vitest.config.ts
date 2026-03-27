import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/api/**/*.test.ts'],
    setupFiles: ['tests/api/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run tests sequentially — they share a database
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
