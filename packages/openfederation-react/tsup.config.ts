import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2020',
  // React / ReactDOM ship with the consuming dApp; @openfederation/sdk is a
  // runtime dep so its peerDeps (ethers, etc.) also stay external.
  external: ['react', 'react-dom', '@openfederation/sdk', 'ethers'],
});
