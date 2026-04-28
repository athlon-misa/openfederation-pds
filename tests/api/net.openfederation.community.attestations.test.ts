import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost, xrpcAuthGet,
  createTestUser, isPLCAvailable, uniqueHandle, getAdminToken,
} from './helpers.js';

describe('Community Attestations', () => {
  let plcAvailable: boolean;
  let owner: { accessJwt: string; did: string; handle: string };
  let member: { accessJwt: string; did: string; handle: string };
  let communityDid: string;
  let attestationRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('att-owner'));
    member = await createTestUser(uniqueHandle('att-member'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('att-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;

    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { communityDid });
  });

  describe('issueAttestation', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcPost('net.openfederation.community.issueAttestation', {
        communityDid: 'did:plc:test', subjectDid: 'did:plc:test2', subjectHandle: 'test',
        type: 'membership', claim: { role: 'athlete' },
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing fields', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, { communityDid });
      expect(res.status).toBe(400);
    });

    it('should reject non-member subject', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: 'did:plc:nonexistent', subjectHandle: 'nobody',
        type: 'membership', claim: { role: 'athlete' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotMember');
    });

    it('should reject claim exceeding 4096 bytes (size cap, issue #47)', async () => {
      if (!plcAvailable) return;
      const oversizedClaim = { data: 'x'.repeat(5000) };
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'credential', claim: oversizedClaim,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PayloadTooLarge');
    });

    it('should reject claim nested deeper than 5 levels (depth cap, issue #47)', async () => {
      if (!plcAvailable) return;
      // Build a deeply-nested object: level 7 > limit 5
      const deep: any = { v: 1 };
      for (let i = 0; i < 7; i++) deep.v = { v: deep.v };
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'credential', claim: deep,
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/nest deeper/i);
    });

    it('should issue an attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'role', claim: { role: 'athlete', position: 'Forward', number: 10 },
      });
      expect(res.status).toBe(200);
      expect(res.body.uri).toContain('net.openfederation.community.attestation');
      expect(res.body.rkey).toBeTruthy();
      attestationRkey = res.body.rkey;
    });
  });

  describe('verifyAttestation', () => {
    it('should verify an existing attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.verifyAttestation', {
        communityDid, rkey: attestationRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.attestation.type).toBe('role');
      expect(res.body.attestation.claim.position).toBe('Forward');
    });

    it('should return valid=false for non-existent attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.verifyAttestation', {
        communityDid, rkey: 'nonexistent',
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });
  });

  describe('listAttestations', () => {
    it('should list attestations for community', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listAttestations', { communityDid });
      expect(res.status).toBe(200);
      expect(res.body.attestations.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by subjectDid', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listAttestations', {
        communityDid, subjectDid: member.did,
      });
      expect(res.status).toBe(200);
      expect(res.body.attestations.every((a: any) => a.subjectDid === member.did)).toBe(true);
    });
  });

  describe('deleteAttestation (revocation)', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcPost('net.openfederation.community.deleteAttestation', {
        communityDid: 'did:plc:test', rkey: 'test',
      });
      expect(res.status).toBe(401);
    });

    it('should delete (revoke) an attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.deleteAttestation', owner.accessJwt, {
        communityDid, rkey: attestationRkey, reason: 'Player transferred',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should no longer verify after revocation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.verifyAttestation', {
        communityDid, rkey: attestationRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });
  });

  describe('deleteAttestation cascade (issue #58)', () => {
    let viewer: { accessJwt: string; did: string; handle: string };
    let cascadeCommDid: string;

    beforeAll(async () => {
      if (!plcAvailable) return;
      viewer = await createTestUser(uniqueHandle('cascade-viewer'));
      const commRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
        handle: uniqueHandle('cascade-comm'),
        didMethod: 'plc',
        visibility: 'public',
        joinPolicy: 'open',
      });
      cascadeCommDid = commRes.body.did;
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: cascadeCommDid });
      await xrpcAuthPost('net.openfederation.community.join', viewer.accessJwt, { did: cascadeCommDid });
    });

    it('revokes all viewing_grants when attestation is deleted', async () => {
      if (!plcAvailable) return;
      const attRes = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid: cascadeCommDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'credential', claim: { level: '3' },
        visibility: 'private',
        accessPolicy: { type: 'community-member', communityDid: cascadeCommDid },
      });
      expect(attRes.status).toBe(200);
      const rkey = attRes.body.rkey;

      const grantRes = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', member.accessJwt, {
        communityDid: cascadeCommDid, rkey, grantedToDid: viewer.did, expiresInMinutes: 60,
      });
      expect(grantRes.status).toBe(200);
      const grantId = grantRes.body.grantId;

      const beforeStatus = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', member.accessJwt, { grantId });
      expect(beforeStatus.body.active).toBe(true);

      await xrpcAuthPost('net.openfederation.community.deleteAttestation', owner.accessJwt, {
        communityDid: cascadeCommDid, rkey,
      });

      const afterStatus = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', member.accessJwt, { grantId });
      expect(afterStatus.body.active).toBe(false);
    });

    it('deletes wrapped DEK material (attestation_encryption) when attestation is deleted', async () => {
      if (!plcAvailable) return;
      const attRes = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid: cascadeCommDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'credential', claim: { level: '3' },
        visibility: 'private',
        accessPolicy: { type: 'community-member', communityDid: cascadeCommDid },
      });
      expect(attRes.status).toBe(200);
      const rkey = attRes.body.rkey;

      const beforeCommit = await xrpcGet('net.openfederation.attestation.verifyCommitment', {
        communityDid: cascadeCommDid, rkey,
      });
      expect(beforeCommit.status).toBe(200);

      await xrpcAuthPost('net.openfederation.community.deleteAttestation', owner.accessJwt, {
        communityDid: cascadeCommDid, rkey,
      });

      const afterCommit = await xrpcGet('net.openfederation.attestation.verifyCommitment', {
        communityDid: cascadeCommDid, rkey,
      });
      expect(afterCommit.status).toBe(404);
    });

    it('records revokedGrants count in the audit entry', async () => {
      if (!plcAvailable) return;
      const attRes = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid: cascadeCommDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'credential', claim: { level: '3' },
        visibility: 'private',
        accessPolicy: { type: 'community-member', communityDid: cascadeCommDid },
      });
      const rkey = attRes.body.rkey;

      await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', member.accessJwt, {
        communityDid: cascadeCommDid, rkey, grantedToDid: viewer.did, expiresInMinutes: 60,
      });

      await xrpcAuthPost('net.openfederation.community.deleteAttestation', owner.accessJwt, {
        communityDid: cascadeCommDid, rkey,
      });

      const adminToken = await getAdminToken();
      const auditRes = await xrpcAuthGet('net.openfederation.audit.list', adminToken, {
        action: 'community.deleteAttestation',
        targetId: cascadeCommDid,
        limit: '10',
      });
      expect(auditRes.status).toBe(200);
      const entry = auditRes.body.entries.find((e: any) => e.meta?.rkey === rkey);
      expect(entry).toBeDefined();
      expect(entry.meta.revokedGrants).toBe(1);
    });
  });
});
