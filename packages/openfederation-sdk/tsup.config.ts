import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs', 'iife'],
  globalName: 'OpenFederation',
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  target: 'es2020',
});
