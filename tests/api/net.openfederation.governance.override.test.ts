/**
 * The override round a hold opens (#199).
 *
 * Before this, `objected` was terminal: `applyDueProposals` only ever looked at
 * `pending-application`, `objectToProposal` refused an already-held proposal,
 * and `voteOnProposal` required `status === 'open'`. At the default threshold of
 * 1 that made any single member holding `community.governance.write` a
 * permanent veto over a majority decision.
 *
 * What is exercised here is the state machine that replaces it, on real signed
 * records:
 *
 *   pending → objection → objection-override → bar reached  → approved, applied
 *   pending → objection → objection-override → round expires → rejected
 *   pending → objection → objected (a community that chose `objectionReview: none`)
 *
 * Time is never waited on. Windows are closed by rewriting the record through
 * the community's own key — a real signed commit, exactly the shape the record
 * would have had if the clock had reached it — so every assertion is
 * deterministic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { query } from '../../src/db/client.js';
import { putProposalRecord } from '../../src/governance/proposal-resolution.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const OBJECTION_COLLECTION = 'net.openfederation.governance.objection';
const TARGET_COLLECTION = 'app.example.governed';

type User = { accessJwt: string; did: string; handle: string };

const MINUTE = 60_000;

async function proposalRecord(communityDid: string, rkey: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, rkey],
  );
  return res.rows[0]?.record;
}

/** Move the whole episode into the past so the contest window has closed. */
async function closeWindow(communityDid: string, rkey: string): Promise<void> {
  const anchor = Date.now();
  const objectedAt = new Date(anchor - 60 * MINUTE).toISOString();

  const raised = await query<{ repo_did: string; rkey: string; record: any }>(
    `SELECT community_did AS repo_did, rkey, record FROM records_index
     WHERE collection = $1 AND record->>'community' = $2 AND record->>'proposalRkey' = $3`,
    [OBJECTION_COLLECTION, communityDid, rkey],
  );
  for (const row of raised.rows) {
    await new RepoEngine(row.repo_did).putRecord(
      await getKeypairForDid(row.repo_did),
      OBJECTION_COLLECTION,
      row.rkey,
      { ...row.record, createdAt: objectedAt },
    );
  }

  const record = await proposalRecord(communityDid, rkey);
  await putProposalRecord(
    new RepoEngine(communityDid), await getKeypairForDid(communityDid), communityDid, rkey,
    {
      ...record,
      resolvedAt: new Date(anchor - 90 * MINUTE).toISOString(),
      applyAt: new Date(anchor - 30 * MINUTE).toISOString(),
    },
  );
}

/** Move an open override round's window into the past. */
async function expireRound(communityDid: string, rkey: string): Promise<void> {
  const record = await proposalRecord(communityDid, rkey);
  await putProposalRecord(
    new RepoEngine(communityDid), await getKeypairForDid(communityDid), communityDid, rkey,
    { ...record, overrideExpiresAt: new Date(Date.now() - 5 * MINUTE).toISOString() },
  );
}

async function auditEntries(action: string, communityDid: string, rkey: string) {
  const res = await query<{ meta: any }>(
    `SELECT meta FROM audit_log
     WHERE action = $1 AND target_id = $2 AND meta->>'rkey' = $3
     ORDER BY id ASC`,
    [action, communityDid, rkey],
  );
  return res.rows.map(r => r.meta);
}

describe('Objection override round (#199)', () => {
  let plcAvailable: boolean;
  let owner: User;
  let voters: User[] = [];
  let communityDid: string;

  const QUORUM = 2;
  /** owner + 4 moderators all hold community.governance.write. */
  const ELECTORATE = 5;
  /** max(quorum + 1, ceil(2/3 * 5)) = max(3, 4) = 4. */
  const EXPECTED_OVERRIDE_QUORUM = 4;

  async function passProposal(targetRkey: string) {
    const created = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: TARGET_COLLECTION,
      targetRkey,
      action: 'write',
      proposedRecord: { value: targetRkey },
    });
    expect(created.status).toBe(200);
    // `createProposal` records the proposer's own seed vote, so one more
    // reaches a quorum of 2.
    const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voters[0].accessJwt, {
      communityDid, proposalRkey: created.body.rkey, vote: 'for',
    });
    expect(vote.status).toBe(200);
    expect(vote.body.status).toBe('pending-application');
    return created.body.rkey as string;
  }

  /** Pass a proposal and have one member object, opening the round. */
  async function heldProposal(targetRkey: string) {
    const rkey = await passProposal(targetRkey);
    const objection = await xrpcAuthPost('net.openfederation.community.objectToProposal', voters[1].accessJwt, {
      communityDid, proposalRkey: rkey, reason: 'not like this',
    });
    expect(objection.status).toBe(200);
    return { rkey, objection: objection.body };
  }

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('ov-owner'));
    for (let i = 0; i < 4; i++) voters.push(await createTestUser(uniqueHandle(`ov-v${i}`)));

    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('ov-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    const roles = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    const modRoleRkey = roles.body.roles.find((r: any) => r.name === 'moderator').rkey;
    for (const v of voters) {
      await xrpcAuthPost('net.openfederation.community.join', v.accessJwt, { did: communityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid, memberDid: v.did, roleRkey: modRoleRkey,
      });
    }

    const model = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: {
        quorum: QUORUM, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 6,
      },
    });
    expect(model.status).toBe(200);
  });

  describe('a hold opens a round instead of ending the matter', () => {
    it('moves the proposal into objection-override with a frozen bar and window', async () => {
      if (!plcAvailable) return;
      const { rkey, objection } = await heldProposal('ov-open');

      expect(objection.status).toBe('objection-override');
      expect(objection.overrideQuorum).toBe(EXPECTED_OVERRIDE_QUORUM);
      expect(objection.overrideExpiresAt).toBeTruthy();

      const record = await proposalRecord(communityDid, rkey);
      expect(record.status).toBe('objection-override');
      expect(record.overrideQuorum).toBe(EXPECTED_OVERRIDE_QUORUM);
      expect(record.overrideElectorate).toBe(ELECTORATE);
      expect(record.overrideOpenedAt).toBeTruthy();
      // The first round's votes do not carry into a round that asks for more.
      expect(record.votesFor).toEqual([]);
      expect(record.votesAgainst).toEqual([]);

      const audit = await auditEntries('community.proposal.overrideOpened', communityDid, rkey);
      expect(audit).toHaveLength(1);
      expect(audit[0].overrideQuorum).toBe(EXPECTED_OVERRIDE_QUORUM);
    });

    it('reports the round through getProposal', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-read');
      const res = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('objection-override');
      expect(res.body.overrideQuorum).toBe(EXPECTED_OVERRIDE_QUORUM);
      expect(res.body.overrideElectorate).toBe(ELECTORATE);
    });

    it('refuses a second objection, directing the objector to the round', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-reobject');
      const again = await xrpcAuthPost('net.openfederation.community.objectToProposal', voters[2].accessJwt, {
        communityDid, proposalRkey: rkey, reason: 'me too',
      });

      expect(again.status).toBe(400);
      expect(again.body.error).toBe('ObjectionWindowClosed');
      expect(again.body.message).toMatch(/vote in that round/);
    });

    it('does not apply the change while the round is running', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-notapplied');
      await closeWindow(communityDid, rkey);
      // The sweep runs on every read; a held proposal must survive it.
      await xrpcGet('net.openfederation.community.listProposals', { communityDid });

      const target = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'ov-notapplied',
      });
      expect(target.status).toBe(404);
      expect((await proposalRecord(communityDid, rkey)).status).toBe('objection-override');
    });
  });

  describe('the round carries', () => {
    it('applies the change once votes for reach the frozen bar', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-carry');

      // Four votes for: owner plus three moderators. The objector is free to
      // vote too, and is simply outvoted rather than silenced.
      const ballots = [owner, voters[0], voters[2], voters[3]];
      let last: any;
      for (const voter of ballots) {
        last = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
          communityDid, proposalRkey: rkey, vote: 'for',
        });
        expect(last.status).toBe(200);
      }

      expect(last.body.status).toBe('approved');
      expect(last.body.applied).toBe(true);
      // No second contest window: the change already served one, and objecting
      // again is refused, so another window would be a delay nobody could use.
      expect(last.body.pendingApplication).toBeUndefined();

      const record = await proposalRecord(communityDid, rkey);
      expect(record.status).toBe('approved');
      expect(record.overrideOutcome).toBe('carried');
      expect(record.appliedAt).toBeTruthy();

      const target = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'ov-carry',
      });
      expect(target.status).toBe(200);
      expect(target.body.value.value).toBe('ov-carry');

      const audit = await auditEntries('community.proposal.overrideCarried', communityDid, rkey);
      expect(audit).toHaveLength(1);
    });

    it('does not carry on the ordinary quorum', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-short');

      // Two votes for — enough to have passed the proposal in the first place,
      // and deliberately not enough to override the objection to it.
      for (const voter of [owner, voters[0]]) {
        const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
          communityDid, proposalRkey: rkey, vote: 'for',
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('objection-override');
      }
      expect((await proposalRecord(communityDid, rkey)).status).toBe('objection-override');
    });

    it('counts only votes for towards the bar', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-against');

      for (const voter of [owner, voters[0], voters[2]]) {
        await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
          communityDid, proposalRkey: rkey, vote: 'for',
        });
      }
      // A fourth vote, against. Under the ordinary rule this would resolve the
      // proposal; the round asks for a mandate, and an objection is not one.
      const against = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voters[3].accessJwt, {
        communityDid, proposalRkey: rkey, vote: 'against',
      });
      expect(against.status).toBe(200);
      expect(against.body.status).toBe('objection-override');
    });
  });

  describe('the round expires', () => {
    it('rejects the proposal, so the objection stands', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-expire');
      await expireRound(communityDid, rkey);

      // Closing is lazy, exactly as application is: the next interaction does it.
      await xrpcGet('net.openfederation.community.listProposals', { communityDid });

      const record = await proposalRecord(communityDid, rkey);
      expect(record.status).toBe('rejected');
      expect(record.overrideOutcome).toBe('expired');

      const target = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'ov-expire',
      });
      expect(target.status).toBe(404);

      const audit = await auditEntries('community.proposal.overrideExpired', communityDid, rkey);
      expect(audit).toHaveLength(1);
    });

    it('refuses a vote cast after the round closed', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-latevote');
      await expireRound(communityDid, rkey);

      const late = await xrpcAuthPost('net.openfederation.community.voteOnProposal', owner.accessJwt, {
        communityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(late.status).toBe(400);
      expect(late.body.error).toBe('ProposalClosed');
    });

    it('closes on a read of the proposal itself, not only a list', async () => {
      if (!plcAvailable) return;
      const { rkey } = await heldProposal('ov-readclose');
      await expireRound(communityDid, rkey);

      const res = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
    });
  });

  describe("a community that wants a hold to be the last word", () => {
    let terminalCommunityDid: string;
    let terminalOwner: User;
    let terminalVoter: User;

    beforeAll(async () => {
      if (!plcAvailable) return;
      terminalOwner = await createTestUser(uniqueHandle('ovn-owner'));
      terminalVoter = await createTestUser(uniqueHandle('ovn-voter'));

      const created = await xrpcAuthPost('net.openfederation.community.create', terminalOwner.accessJwt, {
        handle: uniqueHandle('ovn-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
      });
      terminalCommunityDid = created.body.did;

      const roles = await xrpcGet('net.openfederation.community.listRoles', { communityDid: terminalCommunityDid });
      const modRoleRkey = roles.body.roles.find((r: any) => r.name === 'moderator').rkey;
      await xrpcAuthPost('net.openfederation.community.join', terminalVoter.accessJwt, { did: terminalCommunityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', terminalOwner.accessJwt, {
        communityDid: terminalCommunityDid, memberDid: terminalVoter.did, roleRkey: modRoleRkey,
      });

      await xrpcAuthPost('net.openfederation.community.setGovernanceModel', terminalOwner.accessJwt, {
        communityDid: terminalCommunityDid,
        governanceModel: 'simple-majority',
        governanceConfig: {
          quorum: 2, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 6,
          objectionReview: 'none',
        },
      });
    });

    it('keeps the terminal objected state when it opts out', async () => {
      if (!plcAvailable) return;
      const created = await xrpcAuthPost('net.openfederation.community.createProposal', terminalOwner.accessJwt, {
        communityDid: terminalCommunityDid,
        targetCollection: TARGET_COLLECTION,
        targetRkey: 'ovn-1',
        action: 'write',
        proposedRecord: { value: 'ovn-1' },
      });
      const rkey = created.body.rkey;
      await xrpcAuthPost('net.openfederation.community.voteOnProposal', terminalVoter.accessJwt, {
        communityDid: terminalCommunityDid, proposalRkey: rkey, vote: 'for',
      });

      const objection = await xrpcAuthPost('net.openfederation.community.objectToProposal', terminalVoter.accessJwt, {
        communityDid: terminalCommunityDid, proposalRkey: rkey, reason: 'no',
      });
      expect(objection.status).toBe(200);
      expect(objection.body.status).toBe('objected');
      expect(objection.body.overrideQuorum).toBeUndefined();

      const record = await proposalRecord(terminalCommunityDid, rkey);
      expect(record.status).toBe('objected');
      expect(record.overrideOpenedAt).toBeUndefined();

      // ...and it really is terminal: no round to vote in.
      const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', terminalOwner.accessJwt, {
        communityDid: terminalCommunityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(vote.status).toBe(400);
      expect(vote.body.error).toBe('ProposalClosed');
    });

    it('refuses a governance config naming a review mode nobody implements', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', terminalOwner.accessJwt, {
        communityDid: terminalCommunityDid,
        governanceModel: 'simple-majority',
        governanceConfig: { quorum: 2, voterRole: 'moderator', objectionReview: 'non' },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/objectionReview/);
    });
  });
});
