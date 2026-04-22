import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('Community Governance', () => {
  let plcAvailable: boolean;
  let owner: { accessJwt: string; did: string; handle: string };
  let voter1: { accessJwt: string; did: string; handle: string };
  let voter2: { accessJwt: string; did: string; handle: string };
  let communityDid: string;
  let modRoleRkey: string;
  let proposalRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('gov-owner'));
    voter1 = await createTestUser(uniqueHandle('gov-voter1'));
    voter2 = await createTestUser(uniqueHandle('gov-voter2'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('gov-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;

    const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    modRoleRkey = rolesRes.body.roles.find((r: any) => r.name === 'moderator').rkey;

    await xrpcAuthPost('net.openfederation.community.join', voter1.accessJwt, { communityDid });
    await xrpcAuthPost('net.openfederation.community.join', voter2.accessJwt, { communityDid });
    await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: voter1.did, roleRkey: modRoleRkey,
    });
    await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: voter2.did, roleRkey: modRoleRkey,
    });
  });

  describe('setGovernanceModel', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcPost('net.openfederation.community.setGovernanceModel', {
        communityDid: 'did:plc:test', governanceModel: 'simple-majority',
      });
      expect(res.status).toBe(401);
    });

    it('should reject invalid model', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid, governanceModel: 'on-chain',
      });
      expect(res.status).toBe(400);
    });

    it('should reject simple-majority without config', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid, governanceModel: 'simple-majority',
      });
      expect(res.status).toBe(400);
    });

    it('should switch to simple-majority', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid,
        governanceModel: 'simple-majority',
        governanceConfig: { quorum: 2, voterRole: 'moderator', proposalTtlDays: 7 },
      });
      expect(res.status).toBe(200);
      expect(res.body.governanceModel).toBe('simple-majority');
    });
  });

  describe('governance enforcement', () => {
    it('should block direct writes to protected collections', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.update', owner.accessJwt, {
        did: communityDid, displayName: 'Direct Update',
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('GovernanceDenied');
    });
  });

  describe('createProposal', () => {
    it('should reject for non-governed community member', async () => {
      if (!plcAvailable) return;
      const member = await createTestUser(uniqueHandle('gov-normie'));
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { communityDid });
      const res = await xrpcAuthPost('net.openfederation.community.createProposal', member.accessJwt, {
        communityDid, targetCollection: 'net.openfederation.community.profile',
        targetRkey: 'self', action: 'write', proposedRecord: { displayName: 'New Name' },
      });
      expect(res.status).toBe(403);
    });

    it('should create a proposal', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid,
        targetCollection: 'net.openfederation.community.profile',
        targetRkey: 'self',
        action: 'write',
        proposedRecord: { displayName: 'Voted Name', description: 'Updated via governance' },
      });
      expect(res.status).toBe(200);
      expect(res.body.rkey).toBeTruthy();
      proposalRkey = res.body.rkey;
    });
  });

  describe('getProposal', () => {
    it('should return proposal details', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.getProposal', {
        communityDid, rkey: proposalRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('open');
      expect(res.body.votesFor.length).toBe(1);
      expect(res.body.proposedRecord.displayName).toBe('Voted Name');
    });
  });

  describe('listProposals', () => {
    it('should list proposals', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listProposals', { communityDid });
      expect(res.status).toBe(200);
      expect(res.body.proposals.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by status', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listProposals', {
        communityDid, status: 'open',
      });
      expect(res.status).toBe(200);
      expect(res.body.proposals.every((p: any) => p.status === 'open')).toBe(true);
    });
  });

  describe('voteOnProposal', () => {
    it('should reject duplicate vote', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', owner.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('AlreadyVoted');
    });

    it('should record a vote and auto-approve on majority', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(res.status).toBe(200);
      expect(res.body.recorded).toBe(true);
      expect(res.body.status).toBe('approved');
      expect(res.body.applied).toBe(true);
    });

    it('should have applied the proposed change', async () => {
      if (!plcAvailable) return;
      const recordRes = await xrpcGet('com.atproto.repo.listRecords', {
        repo: communityDid, collection: 'net.openfederation.community.profile',
      });
      expect(recordRes.status).toBe(200);
      const profile = recordRes.body.records?.[0]?.value;
      expect(profile?.displayName).toBe('Voted Name');
    });
  });

  describe('switch back to benevolent-dictator', () => {
    it('should allow downgrade from simple-majority', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid, governanceModel: 'benevolent-dictator',
      });
      expect(res.status).toBe(200);
    });

    it('should allow direct writes after downgrade', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.update', owner.accessJwt, {
        did: communityDid, displayName: 'Direct Update Works Again',
      });
      expect(res.status).toBe(200);
    });
  });
});
