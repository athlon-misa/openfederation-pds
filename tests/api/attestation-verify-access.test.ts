/**
 * Who may verify an attestation.
 *
 * A public attestation in a public community: anyone. A private attestation,
 * or any attestation in a private community: community members, the
 * attestation's subject, a PDS admin, and whoever the subject gave a viewing
 * grant (`attestation.createViewingGrant`) that is still active. Everyone
 * else gets the answer for an attestation that does not exist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcGet, xrpcAuthGet, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';

type User = { accessJwt: string; did: string; handle: string };

describe('attestation verification access', () => {
  let plc = false;
  let owner: User, member: User, subject: User, grantee: User, outsider: User;
  let publicDid: string, privateDid: string;
  let openRkey: string;        // public attestation, public community
  let sealedRkey: string;      // private attestation, public community
  let hiddenRkey: string;      // public attestation, private community

  const verifyAttestation = (communityDid: string, rkey: string, u?: User) => u
    ? xrpcAuthGet('net.openfederation.community.verifyAttestation', u.accessJwt, { communityDid, rkey })
    : xrpcGet('net.openfederation.community.verifyAttestation', { communityDid, rkey });
  const verifyCommitment = (communityDid: string, rkey: string, u?: User) => u
    ? xrpcAuthGet('net.openfederation.attestation.verifyCommitment', u.accessJwt, { communityDid, rkey })
    : xrpcGet('net.openfederation.attestation.verifyCommitment', { communityDid, rkey });
  const grant = async (communityDid: string, rkey: string) => {
    const res = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
      communityDid, rkey, grantedToDid: grantee.did, expiresInMinutes: 10,
    });
    expect(res.status).toBe(200);
    return res.body.grantId as string;
  };

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    [owner, member, subject, grantee, outsider] = await Promise.all(
      ['va-own', 'va-mem', 'va-sub', 'va-grt', 'va-out'].map((h) => createTestUser(uniqueHandle(h))));
    publicDid = (await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('va-pub'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    })).body.did;
    privateDid = (await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('va-priv'), didMethod: 'plc', visibility: 'private', joinPolicy: 'approval',
    })).body.did;
    for (const u of [member, subject]) await xrpcAuthPost('net.openfederation.community.join', u.accessJwt, { did: publicDid });
    // The subject of an attestation must be a member: into the private community by approval.
    await xrpcAuthPost('net.openfederation.community.join', subject.accessJwt, { did: privateDid });
    const pending = await xrpcAuthGet('net.openfederation.community.listJoinRequests', owner.accessJwt, { did: privateDid });
    expect((await xrpcAuthPost('net.openfederation.community.resolveJoinRequest', owner.accessJwt, {
      requestId: pending.body.requests[0].id, action: 'approve',
    })).status).toBe(200);

    const issue = async (communityDid: string, visibility: 'public' | 'private') => {
      const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid, subjectDid: subject.did, subjectHandle: subject.handle, type: 'credential',
        claim: { level: '3' }, visibility,
        ...(visibility === 'private' ? { accessPolicy: { type: 'community-member', communityDid } } : {}),
      });
      expect(res.status).toBe(200);
      return res.body.rkey as string;
    };
    openRkey = await issue(publicDid, 'public');
    sealedRkey = await issue(publicDid, 'private');
    hiddenRkey = await issue(privateDid, 'public');
  });

  it('a public attestation in a public community is verifiable by anyone', async () => {
    if (!plc) return;
    const res = await verifyAttestation(publicDid, openRkey);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  describe('a private attestation', () => {
    it('is not found for anonymous callers and outsiders', async () => {
      if (!plc) return;
      for (const u of [undefined, outsider]) {
        const commitment = await verifyCommitment(publicDid, sealedRkey, u);
        expect(commitment.status).toBe(404);
        expect(commitment.body.error).toBe('NotFound');
        const att = await verifyAttestation(publicDid, sealedRkey, u);
        const missing = await verifyAttestation(publicDid, 'nonexistent', u);
        expect(att.status).toBe(missing.status);
        expect(att.body).toEqual(missing.body);
      }
    });

    it('is verifiable by members and the subject', async () => {
      if (!plc) return;
      for (const u of [member, subject, owner]) {
        const res = await verifyCommitment(publicDid, sealedRkey, u);
        expect(res.status).toBe(200);
        expect(res.body.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('is verifiable by a grantee until the grant is revoked', async () => {
      if (!plc) return;
      const grantId = await grant(publicDid, sealedRkey);
      expect((await verifyCommitment(publicDid, sealedRkey, grantee)).status).toBe(200);
      expect((await verifyAttestation(publicDid, sealedRkey, grantee)).status).toBe(200);
      await xrpcAuthPost('net.openfederation.disclosure.revokeGrant', subject.accessJwt, { grantId });
      expect((await verifyCommitment(publicDid, sealedRkey, grantee)).status).toBe(404);
    });
  });

  describe('an attestation in a private community', () => {
    it('is not found for outsiders', async () => {
      if (!plc) return;
      for (const u of [undefined, outsider, grantee]) {
        const res = await verifyAttestation(privateDid, hiddenRkey, u);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('NotFound');
      }
    });

    it('is verifiable by its subject and by a grantee', async () => {
      if (!plc) return;
      expect((await verifyAttestation(privateDid, hiddenRkey, subject)).status).toBe(200);
      await grant(privateDid, hiddenRkey);
      const res = await verifyAttestation(privateDid, hiddenRkey, grantee);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it('a grant naming fields shows only those fields, and can be redeemed', async () => {
      if (!plc) return;
      const issued = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
        communityDid: privateDid, subjectDid: subject.did, subjectHandle: subject.handle, type: 'credential',
        claim: { level: '3', note: 'internal' },
      });
      expect(issued.status).toBe(200);
      const created = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
        communityDid: privateDid, rkey: issued.body.rkey, grantedToDid: outsider.did, expiresInMinutes: 10, grantedFields: ['level'],
      });
      expect(created.status).toBe(200);
      const seen = await verifyAttestation(privateDid, issued.body.rkey, outsider);
      expect(seen.status).toBe(200);
      expect(seen.body.attestation.claim).toEqual({ level: '3' });
      const redeemed = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', outsider.accessJwt, { grantId: created.body.grantId });
      expect(redeemed.status).toBe(200);
    });
  });
});
