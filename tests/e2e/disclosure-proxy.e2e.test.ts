/**
 * E2E: Disclosure Proxy
 *
 * Tests the full disclosure flow: creating viewing grants,
 * redeeming them for watermarked content, audit trail, and
 * revocation enforcement.
 * Requires PLC directory.
 */
import {
  isPLCAvailable, xrpcAuthPost, xrpcAuthGet,
  createTestUser, uniqueHandle,
  createCommunityWithMember, issuePrivateAttestation,
} from './helpers.js';
import type { CommunityWithMember } from './helpers.js';

let plcAvailable = false;
let ctx: CommunityWithMember;
let viewer: { accessJwt: string; did: string; handle: string };
let privateRkey: string;
let grantId: string;

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  ctx = await createCommunityWithMember('dp');
  viewer = await createTestUser(uniqueHandle('dp-viewer'));

  // Issue a private attestation
  const result = await issuePrivateAttestation(
    ctx.owner.accessJwt,
    ctx.communityDid,
    ctx.member.did,
    ctx.member.handle,
    { classification: 'confidential', projectId: 'prj-42' },
  );
  privateRkey = result.rkey;
});

describe('Disclosure Proxy', () => {
  it('step 1: subject creates viewing grant for viewer', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.attestation.createViewingGrant',
      ctx.member.accessJwt,
      {
        communityDid: ctx.communityDid,
        rkey: privateRkey,
        grantedToDid: viewer.did,
        expiresInMinutes: 60,
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.grantId).toBeDefined();
    grantId = res.body.grantId;
  });

  it('step 2: viewer redeems grant -> gets sessionEncryptedPayload, sessionKey, watermarkId', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.disclosure.redeemGrant',
      viewer.accessJwt,
      { grantId },
    );

    expect(res.status).toBe(200);
    expect(res.body.sessionEncryptedPayload).toBeDefined();
    expect(typeof res.body.sessionEncryptedPayload).toBe('string');
    expect(res.body.sessionKey).toBeDefined();
    expect(typeof res.body.sessionKey).toBe('string');
    expect(res.body.watermarkId).toBeDefined();
    expect(typeof res.body.watermarkId).toBe('string');
    expect(res.body.expiresAt).toBeDefined();
  });

  it('step 3: disclosure audit log shows redeem entry', async () => {
    if (!plcAvailable) return;

    // The subject (member) queries the audit log
    const res = await xrpcAuthGet(
      'net.openfederation.disclosure.auditLog',
      ctx.member.accessJwt,
      { communityDid: ctx.communityDid, rkey: privateRkey },
    );

    expect(res.status).toBe(200);
    expect(res.body.entries).toBeDefined();
    expect(Array.isArray(res.body.entries)).toBe(true);

    const redeemEntry = res.body.entries.find(
      (e: { action: string }) => e.action === 'redeem',
    );
    expect(redeemEntry, 'Expected redeem audit entry').toBeDefined();
    expect(redeemEntry.requesterDid).toBe(viewer.did);
    expect(redeemEntry.watermarkId).toBeDefined();
  });

  it('step 4: subject revokes grant', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.disclosure.revokeGrant',
      ctx.member.accessJwt,
      { grantId },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('step 5: redeem after revocation fails (403)', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.disclosure.redeemGrant',
      viewer.accessJwt,
      { grantId },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('GrantRevoked');
  });
});
