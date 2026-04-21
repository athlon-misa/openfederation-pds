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
  // ethers is an OPTIONAL peerDependency. The EVM signer adapter imports it
  // dynamically; keep it out of every build format so the IIFE stays lean
  // and npm consumers bring their own ethers. If a page loads the IIFE and
  // calls asEthersSigner() without ethers present on window/globalThis, the
  // dynamic import throws a clear install-me error at call time.
  external: ['ethers'],
});
