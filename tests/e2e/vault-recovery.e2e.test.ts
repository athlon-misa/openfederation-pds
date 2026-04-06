/**
 * E2E: Vault Recovery
 *
 * Tests the vault share lifecycle: audit log after registration,
 * security level tiers, escrow registration, and share release
 * verification requirements.
 * Requires PLC directory.
 */
import {
  isPLCAvailable, createTestUser, uniqueHandle,
  xrpcAuthGet, xrpcAuthPost,
} from './helpers.js';

let plcAvailable = false;
let user: { accessJwt: string; did: string; handle: string };

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  user = await createTestUser(uniqueHandle('vr-user'));
});

describe('Vault Recovery', () => {
  it('step 1: vault audit log has shares.created entry after registration', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.vault.auditLog',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    expect(res.body.entries).toBeDefined();
    expect(Array.isArray(res.body.entries)).toBe(true);

    const sharesCreated = res.body.entries.find(
      (e: { action: string }) => e.action === 'shares.created',
    );
    expect(sharesCreated, 'Expected shares.created audit entry').toBeDefined();
  });

  it('step 2: security level is Tier 1, vaultShares: true, escrowRegistered: false', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.account.getSecurityLevel',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    expect(res.body.recoveryTier).toBe(1);
    expect(res.body.tierName).toBe('standard');
    expect(res.body.checklist.vaultShares).toBe(true);
    expect(res.body.checklist.escrowRegistered).toBe(false);
  });

  it('step 3: register escrow -> recoveryTier: 2', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.vault.registerEscrow',
      user.accessJwt,
      {
        escrowProviderDid: 'did:web:escrow.example.com',
        escrowProviderName: 'E2E Test Escrow',
        verificationUrl: 'https://escrow.example.com/verify',
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.recoveryTier).toBe(2);
  });

  it('step 4: security level reflects Tier 2', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.account.getSecurityLevel',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    expect(res.body.recoveryTier).toBe(2);
    expect(res.body.tierName).toBe('enhanced');
    expect(res.body.checklist.escrowRegistered).toBe(true);
  });

  it('step 5: share release requires verification (403)', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.vault.requestShareRelease',
      user.accessJwt,
      {},
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('VerificationRequired');
  });

  it('step 6: audit log contains shares.created + escrow.registered', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.vault.auditLog',
      user.accessJwt,
    );

    expect(res.status).toBe(200);

    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('shares.created');
    expect(actions).toContain('escrow.registered');
  });
});
