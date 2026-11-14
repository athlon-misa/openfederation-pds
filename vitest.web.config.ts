import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: { environment: 'node', include: ['tests/web/**/*.test.{ts,tsx}'] },
  resolve: { alias: {
    '@': resolve(import.meta.dirname, 'web-interface/src'),
    'react': resolve(import.meta.dirname, 'web-interface/node_modules/react'),
    'react-dom': resolve(import.meta.dirname, 'web-interface/node_modules/react-dom'),
    'kbar': resolve(import.meta.dirname, 'web-interface/node_modules/kbar'),
    'next-themes': resolve(import.meta.dirname, 'web-interface/node_modules/next-themes'),
    'next/navigation': resolve(import.meta.dirname, 'web-interface/node_modules/next/navigation.js'),
  } },
});
