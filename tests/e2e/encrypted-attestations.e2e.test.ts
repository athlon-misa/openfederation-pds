/**
 * E2E: Encrypted Attestations
 *
 * Tests the private attestation flow including issuance, commitment
 * verification, viewing grants, and backward compatibility with
 * public attestations.
 * Requires PLC directory.
 */
import {
  isPLCAvailable, xrpcAuthPost, xrpcGet, xrpcAuthGet,
  createCommunityWithMember, issuePrivateAttestation,
} from './helpers.js';
import type { CommunityWithMember } from './helpers.js';

let plcAvailable = false;
let ctx: CommunityWithMember;
let privateRkey: string;
let privateCommitment: string;
let grantId: string;

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  ctx = await createCommunityWithMember('ea');
});

describe('Encrypted Attestations', () => {
  it('step 1: issue public attestation (backward compatible)', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.community.issueAttestation',
      ctx.owner.accessJwt,
      {
        communityDid: ctx.communityDid,
        subjectDid: ctx.member.did,
        subjectHandle: ctx.member.handle,
        type: 'credential',
        claim: { role: 'contributor', level: 3 },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.uri).toBeDefined();
    expect(res.body.cid).toBeDefined();
    expect(res.body.rkey).toBeDefined();
    // Public attestations should NOT have visibility or commitment
    expect(res.body.visibility).toBeUndefined();
    expect(res.body.commitment).toBeUndefined();
  });

  it('step 2: issue private attestation -> get rkey + commitment', async () => {
    if (!plcAvailable) return;

    const result = await issuePrivateAttestation(
      ctx.owner.accessJwt,
      ctx.communityDid,
      ctx.member.did,
      ctx.member.handle,
      { clearance: 'secret', department: 'engineering' },
    );

    expect(result.rkey).toBeDefined();
    expect(result.commitment).toBeDefined();
    expect(typeof result.commitment).toBe('string');
    expect(result.commitment.length).toBeGreaterThan(0);

    privateRkey = result.rkey;
    privateCommitment = result.commitment;
  });

  it('step 3: verifyCommitment -> hash present, no claim content', async () => {
    if (!plcAvailable) return;

    const res = await xrpcGet(
      'net.openfederation.attestation.verifyCommitment',
      { communityDid: ctx.communityDid, rkey: privateRkey },
    );

    expect(res.status).toBe(200);
    expect(res.body.commitment).toBeDefined();
    expect(res.body.commitment.hash).toBe(privateCommitment);
    expect(res.body.visibility).toBe('private');
    expect(res.body.revoked).toBe(false);
    // Should NOT contain decrypted claim content
    expect(res.body.claim).toBeUndefined();
    expect(res.body.clearance).toBeUndefined();
  });

  it('step 4: subject creates viewing grant', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.attestation.createViewingGrant',
      ctx.member.accessJwt,
      {
        communityDid: ctx.communityDid,
        rkey: privateRkey,
        grantedToDid: ctx.owner.did,
        expiresInMinutes: 60,
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.grantId).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
    grantId = res.body.grantId;
  });

  it('step 5: grant status shows active', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.disclosure.grantStatus',
      ctx.member.accessJwt,
      { grantId },
    );

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.expiresAt).toBeDefined();
  });
});
