/**
 * Only the member who made a proposal may amend it. An amendment replaces the
 * proposal's content, clears its votes and restarts its clock, so letting any
 * governance writer do it would let them rewrite others' proposals or stall
 * a vote forever.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';

type User = { accessJwt: string; did: string; handle: string };

describe('amendProposal', () => {
  let plc = false;
  let owner: User, moderator: User;
  let communityDid: string;
  let proposalRkey: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('amend-owner'));
    moderator = await createTestUser(uniqueHandle('amend-mod'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('amend'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;
    const listed = await xrpcAuthGet('net.openfederation.community.listRoles', owner.accessJwt, { communityDid });
    const modRole = listed.body.roles.find((r: any) => r.name === 'moderator').rkey;
    await xrpcAuthPost('net.openfederation.community.join', moderator.accessJwt, { did: communityDid });
    const up = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: moderator.did, roleRkey: modRole,
    });
    expect(up.status).toBe(200);
    const model = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid, governanceModel: 'simple-majority',
      governanceConfig: { quorum: 2, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
    });
    expect(model.status).toBe(200);
    const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid, targetCollection: 'net.openfederation.community.metadata', targetRkey: 'amend-test',
      action: 'write', proposedRecord: { displayName: 'original' },
    });
    expect(proposal.status).toBe(200);
    proposalRkey = proposal.body.rkey;
  });

  it('refuses an amendment from someone other than the proposer', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.community.amendProposal', moderator.accessJwt, {
      communityDid, proposalRkey, proposedRecord: { displayName: 'hijacked' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NotProposer');
  });

  it('lets the proposer amend their own proposal', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.community.amendProposal', owner.accessJwt, {
      communityDid, proposalRkey, proposedRecord: { displayName: 'revised' },
    });
    expect(res.status).toBe(200);
  });
});
