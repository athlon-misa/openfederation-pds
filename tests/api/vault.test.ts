import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost,
  xrpcAuthPost,
  xrpcAuthGet,
  getAdminToken,
  createTestUser,
  uniqueHandle,
  isPLCAvailable,
} from './helpers.js';

describe('Vault Service', () => {
  // ── Auth guards (no setup required) ───────────────────────────────

  it('vault.auditLog requires auth', async () => {
    const res = await xrpcPost('net.openfederation.vault.auditLog');
    expect(res.status).toBe(401);
  });

  it('vault.requestShareRelease requires auth', async () => {
    const res = await xrpcPost('net.openfederation.vault.requestShareRelease');
    expect(res.status).toBe(401);
  });

  it('vault.registerEscrow requires auth', async () => {
    const res = await xrpcPost('net.openfederation.vault.registerEscrow', {
      escrowProviderDid: 'did:example:escrow',
      escrowProviderName: 'Test Escrow',
    });
    expect(res.status).toBe(401);
  });

  it('vault.exportRecoveryKey requires auth', async () => {
    const res = await xrpcPost('net.openfederation.vault.exportRecoveryKey', {
      verificationToken: 'any-token',
    });
    expect(res.status).toBe(401);
  });

  // ── Full flow (requires PLC + admin session) ─────────────────────

  describe('full vault flow', () => {
    let plcAvailable: boolean;
    let adminToken: string;
    let userToken: string;
    let userDid: string;

    beforeAll(async () => {
      plcAvailable = await isPLCAvailable();
      if (!plcAvailable) return;

      try {
        adminToken = await getAdminToken();
        const user = await createTestUser(uniqueHandle('vault'));
        userToken = user.accessJwt;
        userDid = user.did;
      } catch {
        // If admin token or user creation fails (e.g., DB migration), skip flow tests
        plcAvailable = false;
      }
    });

    it('should have created vault shares during registration', async () => {
      if (!plcAvailable) return;

      // The audit log should have a shares.created entry
      const res = await xrpcAuthGet('net.openfederation.vault.auditLog', userToken);
      expect(res.status).toBe(200);
      expect(res.body.entries).toBeDefined();
      expect(Array.isArray(res.body.entries)).toBe(true);

      const createdEntry = res.body.entries.find(
        (e: any) => e.action === 'shares.created'
      );
      expect(createdEntry).toBeDefined();
      expect(createdEntry.metadata?.numShares).toBe(3);
      expect(createdEntry.metadata?.threshold).toBe(2);
    });

    it('requestShareRelease should require verification', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthPost(
        'net.openfederation.vault.requestShareRelease',
        userToken,
        {}
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('VerificationRequired');
    });

    it('registerEscrow requires escrowProviderDid and escrowProviderName', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthPost(
        'net.openfederation.vault.registerEscrow',
        userToken,
        {}
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('registerEscrow should update share 3 to escrow', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthPost(
        'net.openfederation.vault.registerEscrow',
        userToken,
        {
          escrowProviderDid: 'did:web:escrow.example.com',
          escrowProviderName: 'Test Escrow Provider',
          verificationUrl: 'https://escrow.example.com/verify',
        }
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.recoveryTier).toBe(2);
      expect(res.body.escrowProviderDid).toBe('did:web:escrow.example.com');
    });

    it('registerEscrow should reject duplicate escrow registration', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthPost(
        'net.openfederation.vault.registerEscrow',
        userToken,
        {
          escrowProviderDid: 'did:web:other-escrow.example.com',
          escrowProviderName: 'Another Escrow',
        }
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('EscrowAlreadyRegistered');
    });

    it('exportRecoveryKey should require verification token', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthPost(
        'net.openfederation.vault.exportRecoveryKey',
        userToken,
        {}
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('VerificationRequired');
    });

    it('vault audit log should contain all operations', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthGet('net.openfederation.vault.auditLog', userToken);
      expect(res.status).toBe(200);

      const actions = res.body.entries.map((e: any) => e.action);
      expect(actions).toContain('shares.created');
      expect(actions).toContain('escrow.registered');
    });
  });
});
