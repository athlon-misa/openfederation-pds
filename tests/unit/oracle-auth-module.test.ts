/**
 * Chain module Oracle authentication (#193) — module-side unit coverage.
 *
 * `X-Oracle-Key` is no longer part of the global auth path. It is middleware
 * the chain module mounts on a fixed, small set of routes, and it is inert
 * whenever the chain module is disabled. These tests need no database: every
 * assertion here is either about routing surface or about the disabled state,
 * which must short-circuit before any credential lookup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setChainModuleEnabledForTests } from '../../src/config.js';
import {
  CHAIN_ORACLE_AUTHORITY,
  ORACLE_AUTHENTICATED_NSIDS,
  getOracleContext,
  oracleAuthMiddleware,
  oracleRequestAuthority,
  requireOracleAuth,
  uninstallOracleAuth,
} from '../../src/modules/chain/oracle-auth.js';
import {
  clearGovernanceRequestAuthority,
  registerGovernanceRequestAuthority,
  registeredAuthorityName,
  runGovernedMutation,
} from '../../src/governance/request-authority.js';

function mockRes(): any {
  const r: any = { statusCode: 200, body: null };
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (data: unknown) => { r.body = data; return r; };
  return r;
}

function mockReq(headers: Record<string, string> = {}): any {
  return { headers, body: {} };
}

describe('oracle-authenticated route surface', () => {
  it('covers exactly the routes that can be Oracle-authorized', () => {
    expect([...ORACLE_AUTHENTICATED_NSIDS].sort()).toEqual([
      'com.atproto.repo.createRecord',
      'com.atproto.repo.deleteRecord',
      'com.atproto.repo.putRecord',
      'net.openfederation.oracle.submitProof',
    ]);
  });
});

describe('oracle auth middleware — chain module disabled', () => {
  afterEach(() => {
    setChainModuleEnabledForTests(undefined);
  });

  it('never authenticates, even with an X-Oracle-Key header present', async () => {
    setChainModuleEnabledForTests(false);
    const req = mockReq({ 'x-oracle-key': 'ofo_looks_like_a_real_key_value' });
    let nexted = false;

    await oracleAuthMiddleware(req, mockRes(), () => { nexted = true; });

    expect(nexted).toBe(true);
    expect(getOracleContext(req)).toBeNull();
    expect(oracleRequestAuthority.contextFor(req)).toBeNull();
  });

  it('refuses Oracle-guarded handlers with 401', () => {
    setChainModuleEnabledForTests(false);
    const res = mockRes();
    expect(requireOracleAuth(mockReq({ 'x-oracle-key': 'ofo_key' }), res)).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'AuthRequired',
      message: 'Valid X-Oracle-Key header required',
    });
  });
});

describe('oracle auth middleware — chain module enabled', () => {
  afterEach(() => {
    setChainModuleEnabledForTests(undefined);
  });

  it('attributes no context when the header is absent or malformed', async () => {
    setChainModuleEnabledForTests(true);

    const noHeader = mockReq();
    await oracleAuthMiddleware(noHeader, mockRes(), () => {});
    expect(getOracleContext(noHeader)).toBeNull();

    // Wrong prefix — rejected on format, before any credential lookup.
    const malformed = mockReq({ 'x-oracle-key': 'not-an-oracle-key' });
    await oracleAuthMiddleware(malformed, mockRes(), () => {});
    expect(getOracleContext(malformed)).toBeNull();
  });

  it('requireOracleAuth still 401s an unauthenticated request', async () => {
    setChainModuleEnabledForTests(true);
    const req = mockReq();
    await oracleAuthMiddleware(req, mockRes(), () => {});

    const res = mockRes();
    expect(requireOracleAuth(req, res)).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});

describe('oracle request authority', () => {
  afterEach(() => {
    setChainModuleEnabledForTests(undefined);
    clearGovernanceRequestAuthority();
  });

  it('identifies itself with the chain-oracle source', () => {
    expect(oracleRequestAuthority.name).toBe(CHAIN_ORACLE_AUTHORITY);
    expect(CHAIN_ORACLE_AUTHORITY).toBe('chain-oracle');
  });

  it('runs the mutation untouched when no Oracle authorized it', async () => {
    setChainModuleEnabledForTests(true);
    let ran = 0;
    const result = await oracleRequestAuthority.runMutation({
      request: mockReq(),
      context: null,
      governance: { allowed: true, governanceModel: 'on-chain' },
      communityDid: 'did:plc:community',
      collection: 'net.openfederation.community.settings',
      rkey: 'self',
      action: 'write',
      operation: 'put',
      mutate: async () => { ran++; return 'written'; },
    });

    expect(result).toBe('written');
    expect(ran).toBe(1);
  });

  it('ignores contexts attributed by a different authority', async () => {
    setChainModuleEnabledForTests(true);
    const result = await oracleRequestAuthority.runMutation({
      request: mockReq(),
      context: {
        source: 'some-other-module',
        communityDid: 'did:plc:community',
        credentialId: '00000000-0000-4000-8000-000000000000',
        name: 'Impostor',
      },
      governance: { allowed: true, governanceModel: 'on-chain' },
      communityDid: 'did:plc:community',
      collection: 'net.openfederation.community.settings',
      rkey: 'self',
      action: 'write',
      operation: 'put',
      mutate: async () => 'written',
    });

    // No Oracle audit is prepared, so the mutation runs unwrapped rather than
    // being credited to an authority that never authorized it.
    expect(result).toBe('written');
  });

  it('requires proof evidence for an Oracle-authorized on-chain mutation', async () => {
    setChainModuleEnabledForTests(true);
    let ran = 0;

    await expect(oracleRequestAuthority.runMutation({
      request: mockReq(),   // body carries no governanceProof
      context: {
        source: CHAIN_ORACLE_AUTHORITY,
        communityDid: 'did:plc:community',
        credentialId: '00000000-0000-4000-8000-000000000000',
        name: 'Test Oracle',
      },
      governance: { allowed: true, governanceModel: 'on-chain' },
      communityDid: 'did:plc:community',
      collection: 'net.openfederation.community.settings',
      rkey: 'self',
      action: 'write',
      operation: 'put',
      mutate: async () => { ran++; return 'written'; },
    })).rejects.toMatchObject({ status: 400 });

    expect(ran).toBe(0);
  });

  it('leaves the mutation entirely alone when the module is disabled', async () => {
    // Registration is not gated at boot (the flag is a runtime toggle and
    // express routes cannot be unmounted), so the authority stays registered.
    // The guarantee is that a disabled module contributes nothing but a
    // boolean read: core's own mutate() runs, unwrapped and un-audited.
    setChainModuleEnabledForTests(false);
    let ran = 0;

    const result = await oracleRequestAuthority.runMutation({
      request: mockReq({ 'x-oracle-key': 'ofo_whatever' }),
      context: {
        source: CHAIN_ORACLE_AUTHORITY,
        communityDid: 'did:plc:community',
        credentialId: '00000000-0000-4000-8000-000000000000',
        name: 'Test Oracle',
      },
      governance: { allowed: true, governanceModel: 'on-chain' },
      communityDid: 'did:plc:community',
      collection: 'net.openfederation.community.settings',
      rkey: 'self',
      action: 'write',
      operation: 'put',
      mutate: async () => { ran++; return 'written'; },
    });

    expect(result).toBe('written');
    expect(ran).toBe(1);
  });
});

describe('chain module install/uninstall seam', () => {
  afterEach(() => {
    setChainModuleEnabledForTests(undefined);
    clearGovernanceRequestAuthority();
  });

  it('uninstalling withdraws the module authority from core governance', async () => {
    registerGovernanceRequestAuthority(oracleRequestAuthority);
    expect(registeredAuthorityName()).toBe(CHAIN_ORACLE_AUTHORITY);

    uninstallOracleAuth();

    expect(registeredAuthorityName()).toBeNull();
    // Core is back on the pure-federation path: no module code in the write.
    await expect(runGovernedMutation({
      request: mockReq(),
      context: null,
      governance: null,
      communityDid: 'did:plc:community',
      collection: 'net.openfederation.community.settings',
      rkey: 'self',
      action: 'write',
      operation: 'put',
      mutate: async () => 'written',
    })).resolves.toBe('written');
  });

  it('uninstalling does not withdraw another module\'s authority', () => {
    // Latent today (the registry holds one authority), but a module tearing
    // down somebody else's registration is exactly the cross-module damage the
    // boundary work exists to rule out.
    const other = {
      name: 'some-other-module',
      contextFor: () => null,
      runMutation: async <T>(m: { mutate: () => Promise<T> }) => m.mutate(),
    };
    registerGovernanceRequestAuthority(other);

    uninstallOracleAuth();

    expect(registeredAuthorityName()).toBe('some-other-module');
  });
});
