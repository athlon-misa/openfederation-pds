/**
 * Oracle auth extracted from core into module middleware (#193).
 *
 * What is asserted here:
 *
 *   - The core seam (`src/governance/request-authority.ts`) behaves as a
 *     pure-federation PDS needs it to: inert with no module registered,
 *     fail-closed when a module misbehaves, and never swallowing an
 *     authority's mutation error.
 *
 * The structural half — core never importing module code — is enforced by
 * `scripts/check-import-boundaries.ts` and covered by
 * `tests/unit/import-boundaries.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  clearGovernanceRequestAuthority,
  registerGovernanceRequestAuthority,
  registeredAuthorityName,
  resolveGovernanceContext,
  runGovernedMutation,
  type GovernanceRequestAuthority,
  type GovernanceRequestContext,
  type GovernedMutation,
} from '../../src/governance/request-authority.js';

function baseMutation<T>(mutate: () => Promise<T>): GovernedMutation<T> {
  return {
    request: { body: {} },
    context: null,
    governance: null,
    communityDid: 'did:plc:community',
    collection: 'net.openfederation.community.settings',
    rkey: 'self',
    action: 'write',
    operation: 'put',
    mutate,
  };
}

function authority(overrides: Partial<GovernanceRequestAuthority> = {}): GovernanceRequestAuthority {
  return {
    name: 'test-authority',
    contextFor: () => null,
    runMutation: (mutation) => mutation.mutate(),
    ...overrides,
  };
}

describe('governance request authority registry (core seam)', () => {
  afterEach(() => {
    clearGovernanceRequestAuthority();
  });

  it('is inert with no authority registered', async () => {
    expect(registeredAuthorityName()).toBeNull();
    expect(resolveGovernanceContext({ headers: { 'x-oracle-key': 'ofo_whatever' } })).toBeNull();

    let ran = 0;
    const result = await runGovernedMutation(baseMutation(async () => { ran++; return 'ok'; }));
    expect(result).toBe('ok');
    expect(ran).toBe(1);
  });

  it('returns the context a registered authority attributes to a request', () => {
    const context: GovernanceRequestContext = {
      source: 'test-authority',
      communityDid: 'did:plc:community',
      credentialId: 'cred-1',
      name: 'Test Oracle',
    };
    registerGovernanceRequestAuthority(authority({ contextFor: () => context }));
    expect(registeredAuthorityName()).toBe('test-authority');
    expect(resolveGovernanceContext({})).toEqual(context);
  });

  it('fails closed when the authority throws while extracting context', () => {
    registerGovernanceRequestAuthority(authority({
      contextFor: () => { throw new Error('module exploded'); },
    }));
    expect(resolveGovernanceContext({})).toBeNull();
  });

  it('lets the authority wrap a mutation', async () => {
    const seen: string[] = [];
    registerGovernanceRequestAuthority(authority({
      async runMutation(mutation) {
        seen.push('before');
        const result = await mutation.mutate();
        seen.push('after');
        return result;
      },
    }));

    const result = await runGovernedMutation(baseMutation(async () => {
      seen.push('mutate');
      return 42;
    }));

    expect(result).toBe(42);
    expect(seen).toEqual(['before', 'mutate', 'after']);
  });

  it('propagates authority mutation errors instead of swallowing them', async () => {
    let ran = 0;
    registerGovernanceRequestAuthority(authority({
      async runMutation() { throw new Error('proof already consumed'); },
    }));

    await expect(
      runGovernedMutation(baseMutation(async () => { ran++; return 'ok'; })),
    ).rejects.toThrow('proof already consumed');
    expect(ran).toBe(0);
  });

  it('clearing the authority restores the pure-federation path', async () => {
    registerGovernanceRequestAuthority(authority({
      runMutation: async () => { throw new Error('should not run'); },
    }));
    clearGovernanceRequestAuthority();

    expect(registeredAuthorityName()).toBeNull();
    await expect(runGovernedMutation(baseMutation(async () => 'ok'))).resolves.toBe('ok');
  });
});
