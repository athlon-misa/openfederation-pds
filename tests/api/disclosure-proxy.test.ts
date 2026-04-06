import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost, xrpcAuthGet,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('Disclosure Proxy — Time-Limited Access & Watermarking', () => {
  let plcAvailable: boolean;
  let owner: { accessJwt: string; did: string; handle: string };
  let subject: { accessJwt: string; did: string; handle: string };
  let viewer: { accessJwt: string; did: string; handle: string };
  let communityDid: string;
  let privateRkey: string;
  let grantId: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    // Create users
    owner = await createTestUser(uniqueHandle('disc-owner'));
    subject = await createTestUser(uniqueHandle('disc-subject'));
    viewer = await createTestUser(uniqueHandle('disc-viewer'));

    // Create community
    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('disc-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;

    // Join community
    await xrpcAuthPost('net.openfederation.community.join', subject.accessJwt, { communityDid });
    await xrpcAuthPost('net.openfederation.community.join', viewer.accessJwt, { communityDid });

    // Issue a private attestation
    const attestRes = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
      communityDid,
      subjectDid: subject.did,
      subjectHandle: subject.handle,
      type: 'credential',
      claim: { certification: 'Level 5', department: 'Engineering' },
      visibility: 'private',
      accessPolicy: { type: 'community-member', communityDid },
    });
    privateRkey = attestRes.body.rkey;

    // Subject creates a viewing grant for viewer
    const grantRes = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
      communityDid,
      rkey: privateRkey,
      grantedToDid: viewer.did,
      expiresInMinutes: 60,
    });
    grantId = grantRes.body.grantId;
  });

  describe('redeemGrant', () => {
    it('should require authentication', async () => {
      const res = await xrpcPost('net.openfederation.disclosure.redeemGrant', { grantId: 'fake' });
      expect(res.status).toBe(401);
    });

    it('should reject missing grantId', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', viewer.accessJwt, {});
      expect(res.status).toBe(400);
    });

    it('should reject non-existent grant', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', viewer.accessJwt, {
        grantId: '00000000-0000-0000-0000-000000000000',
      });
      expect(res.status).toBe(404);
    });

    it('should reject wrong grantee', async () => {
      if (!plcAvailable) return;
      // Subject tries to redeem a grant that was given to viewer
      const res = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', subject.accessJwt, {
        grantId,
      });
      expect(res.status).toBe(403);
    });

    it('should successfully redeem a valid grant', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', viewer.accessJwt, {
        grantId,
      });
      expect(res.status).toBe(200);
      expect(res.body.sessionEncryptedPayload).toBeDefined();
      expect(res.body.sessionEncryptedPayload.ciphertext).toBeTruthy();
      expect(res.body.sessionEncryptedPayload.iv).toBeTruthy();
      expect(res.body.sessionEncryptedPayload.authTag).toBeTruthy();
      expect(res.body.sessionKey).toBeTruthy();
      expect(res.body.expiresAt).toBeTruthy();
      expect(res.body.watermarkId).toBeTruthy();
    });
  });

  describe('grantStatus', () => {
    it('should require authentication', async () => {
      const res = await xrpcGet('net.openfederation.disclosure.grantStatus', { grantId: 'fake' });
      expect(res.status).toBe(401);
    });

    it('should reject missing grantId', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', viewer.accessJwt, {});
      expect(res.status).toBe(400);
    });

    it('should return grant status for the grantee', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', viewer.accessJwt, { grantId });
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
      expect(res.body.expiresAt).toBeTruthy();
      expect(res.body.accessCount).toBeGreaterThanOrEqual(1);
      expect(res.body.createdAt).toBeTruthy();
    });

    it('should return grant status for the subject', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', subject.accessJwt, { grantId });
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
    });

    it('should reject unauthorized user', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', owner.accessJwt, { grantId });
      // Owner is not subject or grantee
      expect(res.status).toBe(403);
    });
  });

  describe('revokeGrant', () => {
    it('should require authentication', async () => {
      const res = await xrpcPost('net.openfederation.disclosure.revokeGrant', { grantId: 'fake' });
      expect(res.status).toBe(401);
    });

    it('should reject non-subject revoking', async () => {
      if (!plcAvailable) return;
      // Viewer is not the subject, cannot revoke
      const res = await xrpcAuthPost('net.openfederation.disclosure.revokeGrant', viewer.accessJwt, { grantId });
      expect(res.status).toBe(403);
    });

    it('should allow subject to revoke', async () => {
      if (!plcAvailable) return;

      // Create a second grant specifically to revoke in this test
      const grantRes = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
        communityDid,
        rkey: privateRkey,
        grantedToDid: viewer.did,
        expiresInMinutes: 60,
      });
      const revokeGrantId = grantRes.body.grantId;

      const res = await xrpcAuthPost('net.openfederation.disclosure.revokeGrant', subject.accessJwt, {
        grantId: revokeGrantId,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it shows as revoked / inactive
      const statusRes = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', subject.accessJwt, {
        grantId: revokeGrantId,
      });
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.active).toBe(false);
    });

    it('should reject double revoke', async () => {
      if (!plcAvailable) return;

      // Create and immediately revoke
      const grantRes = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
        communityDid,
        rkey: privateRkey,
        grantedToDid: viewer.did,
        expiresInMinutes: 60,
      });
      const doubleRevokeId = grantRes.body.grantId;

      await xrpcAuthPost('net.openfederation.disclosure.revokeGrant', subject.accessJwt, {
        grantId: doubleRevokeId,
      });
      const res = await xrpcAuthPost('net.openfederation.disclosure.revokeGrant', subject.accessJwt, {
        grantId: doubleRevokeId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('AlreadyRevoked');
    });

    it('should prevent redeeming a revoked grant', async () => {
      if (!plcAvailable) return;

      // Create, revoke, then try to redeem
      const grantRes = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
        communityDid,
        rkey: privateRkey,
        grantedToDid: viewer.did,
        expiresInMinutes: 60,
      });
      const revokedId = grantRes.body.grantId;

      await xrpcAuthPost('net.openfederation.disclosure.revokeGrant', subject.accessJwt, {
        grantId: revokedId,
      });

      const redeemRes = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', viewer.accessJwt, {
        grantId: revokedId,
      });
      expect(redeemRes.status).toBe(403);
      expect(redeemRes.body.error).toBe('GrantRevoked');
    });
  });

  describe('auditLog', () => {
    it('should require authentication', async () => {
      const res = await xrpcGet('net.openfederation.disclosure.auditLog', { communityDid: 'did:plc:test' });
      expect(res.status).toBe(401);
    });

    it('should reject missing parameters', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.disclosure.auditLog', subject.accessJwt, {});
      expect(res.status).toBe(400);
    });

    it('should return audit entries for attestation subject', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.disclosure.auditLog', subject.accessJwt, {
        communityDid,
        rkey: privateRkey,
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.entries)).toBe(true);
      expect(res.body.entries.length).toBeGreaterThanOrEqual(1);

      // Should have at least one 'redeem' entry from earlier test
      const redeemEntries = res.body.entries.filter((e: any) => e.action === 'redeem');
      expect(redeemEntries.length).toBeGreaterThanOrEqual(1);
    });
  });
});
