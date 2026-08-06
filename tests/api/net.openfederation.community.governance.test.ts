import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { getClient, query } from '../../src/db/client.js';

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

    await xrpcAuthPost('net.openfederation.community.join', voter1.accessJwt, { did: communityDid });
    await xrpcAuthPost('net.openfederation.community.join', voter2.accessJwt, { did: communityDid });
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
        communityDid, governanceModel: 'plutocracy',
      });
      expect(res.status).toBe(400);
    });

    it('should reject on-chain without config', async () => {
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
        governanceConfig: { quorum: 2, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
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
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
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
    it('does not apply a target when concurrent votes reject the proposal', async () => {
      if (!plcAvailable) return;
      const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid, targetCollection: 'net.openfederation.community.metadata', targetRkey: 'concurrent-vote',
        action: 'write', proposedRecord: { displayName: 'Must Not Be Applied' },
      });
      expect(proposal.status).toBe(200);

      const inputFor = { communityDid, proposalRkey: proposal.body.rkey, vote: 'for' };
      const inputAgainst = { communityDid, proposalRkey: proposal.body.rkey, vote: 'against' };
      const lockKey = `community-proposal:${communityDid}:${proposal.body.rkey}`;
      const lockClient = await getClient();
      await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      let forVote!: Promise<Awaited<ReturnType<typeof xrpcAuthPost>>>;
      let againstVote!: Promise<Awaited<ReturnType<typeof xrpcAuthPost>>>;
      try {
        againstVote = Promise.resolve(xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, inputAgainst));
        const deadline = Date.now() + 1_000;
        while (true) {
          const waitingLocks = await lockClient.query<{ count: string }>(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = hashtext($1)::bit(32)::bigint AND NOT granted",
            [lockKey]
          );
          if (Number(waitingLocks.rows[0].count) > 0) break;
          if (Date.now() >= deadline) throw new Error('Rejecting vote did not queue behind the proposal lock');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        forVote = Promise.resolve(xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, inputFor));
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        lockClient.release();
      }
      const [forResult, againstResult] = await Promise.all([forVote, againstVote]);
      expect(againstResult.status).toBe(200);
      expect(againstResult.body.status).toBe('rejected');
      expect(forResult.status).toBe(400);
      expect(forResult.body.error).toBe('ProposalClosed');

      const resolved = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey: proposal.body.rkey });
      expect(resolved.body.status).toBe('rejected');
      const target = await xrpcGet('com.atproto.repo.getRecord', { repo: communityDid, collection: 'net.openfederation.community.metadata', rkey: 'concurrent-vote' });
      expect(target.status).toBe(404);
    });

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
    it('refuses a direct model change under a voting model — no admin override', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid, governanceModel: 'benevolent-dictator',
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('GovernanceDenied');
      expect(res.body.requiresProposal).toBe(true);
    });

    it('should allow downgrade from simple-majority through a proposal', async () => {
      if (!plcAvailable) return;
      const settings = await query<{ record: any }>(
        `SELECT record FROM records_index
         WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
        [communityDid],
      );
      const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid,
        targetCollection: 'net.openfederation.community.settings',
        targetRkey: 'self',
        action: 'write',
        proposedRecord: { ...settings.rows[0].record, governanceModel: 'benevolent-dictator' },
      });
      expect(proposal.status).toBe(200);

      const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey: proposal.body.rkey, vote: 'for',
      });
      expect(vote.status).toBe(200);
      expect(vote.body.status).toBe('approved');
      expect(vote.body.applied).toBe(true);
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
