import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// SDK_VERSION in src/index.ts comes from package.json, so it never goes stale.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const define = { __SDK_VERSION__: JSON.stringify(version) };

export default defineConfig([{
  entry: ['src/index.ts'],
  format: ['esm', 'cjs', 'iife'],
  globalName: 'OpenFederation',
  define,
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
  // `node:dns/promises` is imported dynamically by the SIWOF outbound guard to
  // resolve did:web hosts before fetching them. Keeping it external means the
  // browser builds do not try to bundle a Node builtin; the import throws there
  // and the guard falls back to its isomorphic checks.
  external: ['ethers', 'node:dns/promises'],
}, {
  // @open-federation/sdk/custody (ADR-003): ESM and CJS only, never in the
  // /sdk/v1.js IIFE, so existing IIFE consumers' bundles don't change.
  entry: { custody: 'src/custody/index.ts' },
  format: ['esm', 'cjs'],
  define,
  dts: true,
  clean: false,
  sourcemap: true,
  minify: true,
  target: 'es2020',
}]);
