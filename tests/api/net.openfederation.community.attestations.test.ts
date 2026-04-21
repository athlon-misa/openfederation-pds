import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
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
});
