/**
 * The commitment to a private claim is `sha256(salt:claim)`. The salt is what
 * stops anyone guessing a low-entropy claim, so it goes only to someone the
 * subject has disclosed the whole claim to, never to the public.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcGet, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { createCommitment } from '../../src/attestation/encryption.js';

type User = { accessJwt: string; did: string; handle: string };
const CLAIM = { over18: true };

describe('commitment salt', () => {
  let plc: boolean;
  let owner: User, subject: User, viewer: User;
  let communityDid: string;
  let rkey: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('salt-owner'));
    subject = await createTestUser(uniqueHandle('salt-subject'));
    viewer = await createTestUser(uniqueHandle('salt-viewer'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('salt'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;
    for (const u of [subject, viewer]) await xrpcAuthPost('net.openfederation.community.join', u.accessJwt, { did: communityDid });
    const issued = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
      communityDid, subjectDid: subject.did, subjectHandle: subject.handle, type: 'credential',
      claim: CLAIM, visibility: 'private', accessPolicy: { type: 'community-member', communityDid },
    });
    expect(issued.status).toBe(200);
    rkey = issued.body.rkey;
  });

  const publicCommitment = () => xrpcGet('net.openfederation.attestation.verifyCommitment', { communityDid, rkey });
  const grantTo = async (fields?: string[]) => (await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
    communityDid, rkey, grantedToDid: viewer.did, expiresInMinutes: 10, ...(fields ? { grantedFields: fields } : {}),
  })).body.grantId as string;

  it('the public commitment carries no salt, so a guessable claim cannot be confirmed by guessing', async () => {
    if (!plc) return;
    const res = await publicCommitment();
    expect(res.status).toBe(200);
    expect(res.body.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.commitment.salt).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/salt/i);
  });

  it('someone granted the whole claim receives the salt and can check the claim against the commitment', async () => {
    if (!plc) return;
    const redeemed = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', viewer.accessJwt, { grantId: await grantTo() });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.commitmentSalt).toMatch(/^[0-9a-f]{64}$/);
    const published = (await publicCommitment()).body.commitment.hash;
    expect(createCommitment(CLAIM, redeemed.body.commitmentSalt).hash).toBe(published);
  });

  it('someone granted only some fields does not receive the salt', async () => {
    if (!plc) return;
    // With the salt and part of the claim, the rest could be brute-forced.
    const redeemed = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', viewer.accessJwt, { grantId: await grantTo(['over18']) });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.commitmentSalt).toBeUndefined();
  });
});
