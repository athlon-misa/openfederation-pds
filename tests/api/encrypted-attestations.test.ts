import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost, xrpcAuthGet,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('Encrypted Attestations & Selective Disclosure', () => {
  let plcAvailable: boolean;
  let owner: { accessJwt: string; did: string; handle: string };
  let member: { accessJwt: string; did: string; handle: string };
  let viewer: { accessJwt: string; did: string; handle: string };
  let communityDid: string;
  let privateRkey: string;
  let publicRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('enc-owner'));
    member = await createTestUser(uniqueHandle('enc-member'));
    viewer = await createTestUser(uniqueHandle('enc-viewer'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('enc-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;

    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { communityDid });
    await xrpcAuthPost('net.openfederation.community.join', viewer.accessJwt, { communityDid });
  });

  describe('issueAttestation with visibility', () => {
    it('should issue a public attestation (default, backward-compatible)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'role', claim: { role: 'athlete', position: 'Forward' },
      });
      expect(res.status).toBe(200);
      expect(res.body.uri).toContain('net.openfederation.community.attestation');
      expect(res.body.rkey).toBeTruthy();
      expect(res.body.visibility).toBeUndefined(); // public does not return visibility
      publicRkey = res.body.rkey;
    });

    it('should issue a private attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'credential', claim: { certification: 'Level 3', issueDate: '2026-01-01' },
        visibility: 'private',
        accessPolicy: { type: 'community-member', communityDid },
      });
      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe('private');
      expect(res.body.commitment).toBeTruthy();
      expect(res.body.commitment).toMatch(/^[0-9a-f]{64}$/);
      privateRkey = res.body.rkey;
    });

    it('should reject invalid visibility', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: member.did, subjectHandle: member.handle,
        type: 'role', claim: { role: 'test' },
        visibility: 'secret',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('verifyCommitment', () => {
    it('should return commitment for a private attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.attestation.verifyCommitment', {
        communityDid, rkey: privateRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.issuerDid).toBe(communityDid);
      expect(res.body.visibility).toBe('private');
      expect(res.body.revoked).toBe(false);
    });

    it('should return 404 for non-existent attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.attestation.verifyCommitment', {
        communityDid, rkey: 'nonexistent',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('requestDisclosure', () => {
    it('should require authentication', async () => {
      const res = await xrpcPost('net.openfederation.attestation.requestDisclosure', {
        communityDid: 'did:plc:test', rkey: 'test',
      });
      expect(res.status).toBe(401);
    });

    it('should reject disclosure for public attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.attestation.requestDisclosure', member.accessJwt, {
        communityDid, rkey: publicRkey,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('AttestationPublic');
    });

    it('should allow subject to request disclosure of private attestation', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.attestation.requestDisclosure', member.accessJwt, {
        communityDid, rkey: privateRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.encryptedDEK).toBeTruthy();
      expect(res.body.ciphertext).toBeTruthy();
      expect(res.body.iv).toBeTruthy();
      expect(res.body.authTag).toBeTruthy();
    });

    it('should allow community member to request disclosure (policy: community-member)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.attestation.requestDisclosure', viewer.accessJwt, {
        communityDid, rkey: privateRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.encryptedDEK).toBeTruthy();
    });
  });

  describe('createViewingGrant', () => {
    it('should require authentication', async () => {
      const res = await xrpcPost('net.openfederation.attestation.createViewingGrant', {
        communityDid: 'did:plc:test', rkey: 'test', grantedToDid: 'did:plc:other',
      });
      expect(res.status).toBe(401);
    });

    it('should reject non-subject creating a grant', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', viewer.accessJwt, {
        communityDid, rkey: privateRkey, grantedToDid: owner.did,
      });
      expect(res.status).toBe(403);
    });

    it('should allow subject to create a viewing grant', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', member.accessJwt, {
        communityDid, rkey: privateRkey, grantedToDid: viewer.did,
        expiresInMinutes: 30,
      });
      expect(res.status).toBe(200);
      expect(res.body.grantId).toBeTruthy();
      expect(res.body.expiresAt).toBeTruthy();
    });
  });
});
