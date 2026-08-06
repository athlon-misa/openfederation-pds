/**
 * Oracle auth extracted from core into module middleware (#193).
 *
 * Two things are asserted here:
 *
 *   1. The core seam (`src/governance/request-authority.ts`) behaves as a
 *      pure-federation PDS needs it to: inert with no module registered,
 *      fail-closed when a module misbehaves, and never swallowing an
 *      authority's mutation error.
 *   2. Core stays structurally free of oracle/chain surface — the global auth
 *      middleware, shared guards, shared auth types, and the three ATProto
 *      repo write endpoints must not mention oracle or chain at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

describe('core is free of oracle/chain surface', () => {
  const CORE_FILES = [
    'src/auth/middleware.ts',
    'src/auth/guards.ts',
    'src/auth/types.ts',
    'src/api/com.atproto.repo.createRecord.ts',
    'src/api/com.atproto.repo.putRecord.ts',
    'src/api/com.atproto.repo.deleteRecord.ts',
  ];

  it.each(CORE_FILES)('%s has no oracle or chain references', (relPath) => {
    const source = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    // Comments explaining the absence are allowed; identifiers and imports
    // are not. Strip line comments before matching.
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n');

    expect(code).not.toMatch(/oracle/i);
    expect(code).not.toMatch(/x-oracle-key/i);
    expect(code).not.toMatch(/chain/i);
  });
});
