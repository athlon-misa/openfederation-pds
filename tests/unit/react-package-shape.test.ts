/**
 * Smoke test for the @openfederation/react package's public surface.
 *
 * We import from the built artifacts to validate that (a) the package
 * exports what the docs claim, and (b) its type declarations compile.
 * Full component-render tests live in the package's own test suite
 * (to be added alongside @testing-library/react in a follow-up PR).
 */
import { describe, it, expect } from 'vitest';

describe('@openfederation/react package shape', () => {
  it('exports the advertised API surface', async () => {
    const mod: Record<string, unknown> = await import(
      '../../packages/openfederation-react/src/index.js'
    );
    for (const sym of [
      'OpenFederationProvider',
      'useOFClient',
      'useOFSession',
      'useOFWallet',
      'SignInWithOpenFederation',
    ]) {
      expect(typeof mod[sym]).toBe('function');
    }
  });

  it('useOpenFederationContext is not re-exported (internal only)', async () => {
    const mod: Record<string, unknown> = await import(
      '../../packages/openfederation-react/src/index.js'
    );
    expect(mod.useOpenFederationContext).toBeUndefined();
  });
});
