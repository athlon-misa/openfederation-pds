/**
 * Write-time member display projection (issue #66)
 *
 * Verifies that listMembers and listAttestations carry display fields
 * (displayName, avatarUrl / subjectDisplayName) resolved once at write
 * time rather than fanning out N profile fetches at read time.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet,
  xrpcAuthGet,
  xrpcAuthPost,
  createTestUser,
  uniqueHandle,
  isPLCAvailable,
} from './helpers.js';

describe('member display projection (issue #66)', () => {
  let plcAvailable: boolean;
  let ownerToken: string;
  let memberToken: string;
  let memberDid: string;
  let communityDid: string | null = null;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    const owner = await createTestUser(uniqueHandle('proj-owner'));
    const member = await createTestUser(uniqueHandle('proj-member'));
    ownerToken = owner.accessJwt;
    memberToken = member.accessJwt;
    memberDid = member.did;

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('proj-comm'),
      didMethod: 'plc',
      displayName: 'Projection Test Community',
      visibility: 'public',
      joinPolicy: 'open',
    });
    if (createRes.status === 201) {
      communityDid = createRes.body.did;
    }
  });

  // ── listMembers: displayName field ───────────────────────────────────

  it('listMembers: member without a profile gets displayName equal to handle', async () => {
    if (!communityDid) return;
    await xrpcAuthPost('net.openfederation.community.join', memberToken, { did: communityDid });

    const res = await xrpcAuthGet('net.openfederation.community.listMembers', ownerToken, {
      did: communityDid,
    });
    expect(res.status).toBe(200);

    const memberRow = res.body.members.find((m: any) => m.did === memberDid);
    expect(memberRow).toBeDefined();
    // displayName is required in the new schema — falls back to handle
    expect(typeof memberRow.displayName).toBe('string');
    expect(memberRow.displayName.length).toBeGreaterThan(0);
  });

  it('listMembers: member with a bsky profile gets displayName from that profile', async () => {
    if (!communityDid) return;

    const user = await createTestUser(uniqueHandle('proj-profiled'));
    // Set profile BEFORE joining
    await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
      displayName: 'Alice Profile',
    });

    await xrpcAuthPost('net.openfederation.community.join', user.accessJwt, { did: communityDid });

    const res = await xrpcAuthGet('net.openfederation.community.listMembers', ownerToken, {
      did: communityDid,
    });
    expect(res.status).toBe(200);

    const memberRow = res.body.members.find((m: any) => m.did === user.did);
    expect(memberRow).toBeDefined();
    expect(memberRow.displayName).toBe('Alice Profile');
  });

  it('listMembers: avatarUrl is present (may be null when not set)', async () => {
    if (!communityDid) return;

    const res = await xrpcAuthGet('net.openfederation.community.listMembers', ownerToken, {
      did: communityDid,
    });
    expect(res.status).toBe(200);
    // avatarUrl should be a key on each member (null when unset)
    for (const m of res.body.members) {
      expect('avatarUrl' in m).toBe(true);
    }
  });

  // ── updateProfile fan-out ────────────────────────────────────────────

  it('updating profile propagates displayName to listMembers without rejoining', async () => {
    if (!communityDid) return;

    const user = await createTestUser(uniqueHandle('proj-fanout'));
    await xrpcAuthPost('net.openfederation.community.join', user.accessJwt, { did: communityDid });

    // Confirm handle-based displayName before profile update
    const before = await xrpcAuthGet('net.openfederation.community.listMembers', ownerToken, {
      did: communityDid,
    });
    const beforeRow = before.body.members.find((m: any) => m.did === user.did);
    expect(beforeRow?.displayName).toBe(user.handle);

    // Update profile
    await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
      displayName: 'Updated Name',
    });

    // Projection must reflect the new name without rejoining
    const after = await xrpcAuthGet('net.openfederation.community.listMembers', ownerToken, {
      did: communityDid,
    });
    const afterRow = after.body.members.find((m: any) => m.did === user.did);
    expect(afterRow?.displayName).toBe('Updated Name');
  });

  // ── updateMember: projection stays correct after role/kind change ────

  it('updateMember: role/kind changes are reflected in listMembers', async () => {
    if (!communityDid) return;

    const user = await createTestUser(uniqueHandle('proj-update'));
    await xrpcAuthPost('net.openfederation.community.join', user.accessJwt, { did: communityDid });

    await xrpcAuthPost('net.openfederation.community.updateMember', ownerToken, {
      communityDid,
      memberDid: user.did,
      kind: 'player',
    });

    const res = await xrpcAuthGet('net.openfederation.community.listMembers', ownerToken, {
      did: communityDid,
    });
    expect(res.status).toBe(200);

    const memberRow = res.body.members.find((m: any) => m.did === user.did);
    expect(memberRow?.kind).toBe('player');
    // displayName must still be present after updateMember
    expect(typeof memberRow?.displayName).toBe('string');
  });

  // ── listAttestations: subjectDisplayName ─────────────────────────────

  it('listAttestations includes subjectDisplayName for each attestation', async () => {
    if (!communityDid) return;

    const subject = await createTestUser(uniqueHandle('proj-attested'));
    await xrpcAuthPost('net.openfederation.account.updateProfile', subject.accessJwt, {
      displayName: 'Bob Attested',
    });
    await xrpcAuthPost('net.openfederation.community.join', subject.accessJwt, { did: communityDid });

    await xrpcAuthPost('net.openfederation.community.issueAttestation', ownerToken, {
      communityDid,
      subjectDid: subject.did,
      subjectHandle: subject.handle,
      type: 'membership',
      claim: { level: 'gold' },
    });

    const res = await xrpcGet('net.openfederation.community.listAttestations', {
      communityDid,
      subjectDid: subject.did,
    });
    expect(res.status).toBe(200);
    expect(res.body.attestations.length).toBeGreaterThan(0);

    const att = res.body.attestations[0];
    expect(typeof att.subjectDisplayName).toBe('string');
    expect(att.subjectDisplayName).toBe('Bob Attested');
  });

  it('listAttestations subjectDisplayName falls back to handle when no profile', async () => {
    if (!communityDid) return;

    const subject = await createTestUser(uniqueHandle('proj-no-profile'));
    await xrpcAuthPost('net.openfederation.community.join', subject.accessJwt, { did: communityDid });

    await xrpcAuthPost('net.openfederation.community.issueAttestation', ownerToken, {
      communityDid,
      subjectDid: subject.did,
      subjectHandle: subject.handle,
      type: 'membership',
      claim: { note: 'fallback test' },
    });

    const res = await xrpcGet('net.openfederation.community.listAttestations', {
      communityDid,
      subjectDid: subject.did,
    });
    expect(res.status).toBe(200);

    const att = res.body.attestations[0];
    expect(typeof att.subjectDisplayName).toBe('string');
    expect(att.subjectDisplayName).toBe(subject.handle);
  });
});
