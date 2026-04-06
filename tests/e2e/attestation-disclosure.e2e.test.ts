/**
 * E2E: Attestation + Disclosure (Cross-Cutting)
 *
 * Tests the full attestation lifecycle across public/private modes,
 * access policy enforcement, viewing grants, redemption with watermarking,
 * audit trail, and grant revocation.
 * Requires PLC directory.
 */
import {
  isPLCAvailable, xrpcAuthPost, xrpcGet, xrpcAuthGet,
  createTestUser, uniqueHandle,
  createCommunityWithMember, issuePrivateAttestation,
} from './helpers.js';
import type { CommunityWithMember } from './helpers.js';

let plcAvailable = false;
let ctx: CommunityWithMember;
let thirdParty: { accessJwt: string; did: string; handle: string };
let publicRkey: string;
let privateRkey: string;
let privateCommitment: string;
let grantId: string;

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  ctx = await createCommunityWithMember('ad');
  thirdParty = await createTestUser(uniqueHandle('ad-third'));
});

describe('Attestation + Disclosure', () => {
  it('step 1: issue public attestation', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.community.issueAttestation',
      ctx.owner.accessJwt,
      {
        communityDid: ctx.communityDid,
        subjectDid: ctx.member.did,
        subjectHandle: ctx.member.handle,
        type: 'membership',
        claim: { status: 'active', joinedAt: '2024-01-01' },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.rkey).toBeDefined();
    publicRkey = res.body.rkey;
  });

  it('step 2: issue private attestation with did-allowlist policy containing member DID', async () => {
    if (!plcAvailable) return;

    const result = await issuePrivateAttestation(
      ctx.owner.accessJwt,
      ctx.communityDid,
      ctx.member.did,
      ctx.member.handle,
      { salary: 150000, currency: 'USD', department: 'engineering' },
      { type: 'did-allowlist', dids: [ctx.member.did] },
    );

    expect(result.rkey).toBeDefined();
    expect(result.commitment).toBeDefined();
    privateRkey = result.rkey;
    privateCommitment = result.commitment;
  });

  it('step 3: verifyCommitment -> hash, no content', async () => {
    if (!plcAvailable) return;

    const res = await xrpcGet(
      'net.openfederation.attestation.verifyCommitment',
      { communityDid: ctx.communityDid, rkey: privateRkey },
    );

    expect(res.status).toBe(200);
    expect(res.body.commitment.hash).toBe(privateCommitment);
    expect(res.body.visibility).toBe('private');
    // No plaintext claim content should be returned
    expect(res.body.salary).toBeUndefined();
    expect(res.body.department).toBeUndefined();
  });

  it('step 4: member requests disclosure -> succeeds (in did-allowlist)', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.attestation.requestDisclosure',
      ctx.member.accessJwt,
      {
        communityDid: ctx.communityDid,
        rkey: privateRkey,
        purpose: 'Self-review',
      },
    );

    expect(res.status).toBe(200);
    // The response should contain encrypted data (re-wrapped DEK)
    expect(res.body.encryptedDEK).toBeDefined();
    expect(res.body.ciphertext).toBeDefined();
  });

  it('step 5: third party requests disclosure -> 403', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.attestation.requestDisclosure',
      thirdParty.accessJwt,
      {
        communityDid: ctx.communityDid,
        rkey: privateRkey,
      },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('step 6: subject creates viewing grant for third party', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.attestation.createViewingGrant',
      ctx.member.accessJwt,
      {
        communityDid: ctx.communityDid,
        rkey: privateRkey,
        grantedToDid: thirdParty.did,
        expiresInMinutes: 60,
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.grantId).toBeDefined();
    grantId = res.body.grantId;
  });

  it('step 7: third party redeems grant -> watermarked content', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.disclosure.redeemGrant',
      thirdParty.accessJwt,
      { grantId },
    );

    expect(res.status).toBe(200);
    expect(res.body.sessionEncryptedPayload).toBeDefined();
    expect(res.body.sessionKey).toBeDefined();
    expect(res.body.watermarkId).toBeDefined();
    expect(typeof res.body.watermarkId).toBe('string');
  });

  it('step 8: disclosure audit log has redeem entry', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.disclosure.auditLog',
      ctx.member.accessJwt,
      { communityDid: ctx.communityDid, rkey: privateRkey },
    );

    expect(res.status).toBe(200);
    const redeemEntry = res.body.entries.find(
      (e: { action: string }) => e.action === 'redeem',
    );
    expect(redeemEntry, 'Expected redeem entry in disclosure audit log').toBeDefined();
    expect(redeemEntry.requesterDid).toBe(thirdParty.did);
  });

  it('step 9: subject revokes grant', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.disclosure.revokeGrant',
      ctx.member.accessJwt,
      { grantId },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('step 10: redeem after revocation -> 403', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.disclosure.redeemGrant',
      thirdParty.accessJwt,
      { grantId },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('GrantRevoked');
  });
});
