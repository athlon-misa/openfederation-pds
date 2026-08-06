import { describe, it, expect, beforeAll } from 'vitest';
import { Repo } from '@atproto/repo';
import {
  xrpcGet, xrpcAuthGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { PgBlockstore } from '../../src/repo/pg-blockstore.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { query } from '../../src/db/client.js';
import { ensureDecisionRecord, quorumRule } from '../../src/governance/proposal-resolution.js';

const VOTE_COLLECTION = 'net.openfederation.governance.vote';
const DECISION_COLLECTION = 'net.openfederation.governance.decision';
const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const TARGET_COLLECTION = 'app.example.governed';

type User = { accessJwt: string; did: string; handle: string };

/** Read a record straight out of the MST, not the records_index cache. */
async function readFromMst(did: string, collection: string, rkey: string) {
  const repo = await Repo.load(new PgBlockstore(did));
  return repo.getRecord(collection, rkey);
}

async function getProposal(communityDid: string, rkey: string) {
  const res = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey });
  expect(res.status).toBe(200);
  return res.body;
}

async function getProposalCid(communityDid: string, rkey: string): Promise<string> {
  const res = await xrpcGet('com.atproto.repo.getRecord', {
    repo: communityDid, collection: PROPOSAL_COLLECTION, rkey,
  });
  expect(res.status).toBe(200);
  return res.body.cid;
}

async function listDecisions(communityDid: string, token: string) {
  const res = await xrpcAuthGet('com.atproto.repo.listRecords', token, {
    repo: communityDid, collection: DECISION_COLLECTION,
  });
  expect(res.status).toBe(200);
  return res.body.records as Array<{ uri: string; cid: string; value: any }>;
}

async function decisionFor(communityDid: string, token: string, proposalRkey: string) {
  const records = await listDecisions(communityDid, token);
  return records.filter(r => r.value.proposalRkey === proposalRkey);
}

/** The voter-signed vote record a voter holds for a proposal, read from their repo. */
async function voteRecordOf(voter: User, proposalRkey: string) {
  const res = await xrpcAuthGet('com.atproto.repo.listRecords', voter.accessJwt, {
    repo: voter.did, collection: VOTE_COLLECTION,
  });
  expect(res.status).toBe(200);
  const records = res.body.records as Array<{ uri: string; cid: string; value: any }>;
  return records.find(r => r.value.proposalRkey === proposalRkey);
}

/**
 * Add a vote to the proposal's *cache* only, with no vote record behind it —
 * the shape of a vote cast by an account with no repo (external user, bootstrap
 * admin) or by a proposal seeded before the evidence model existed.
 */
async function injectCacheOnlyVote(communityDid: string, rkey: string, voterDid: string) {
  await query(
    `UPDATE records_index
     SET record = jsonb_set(record, '{votesFor}', (record->'votesFor') || to_jsonb($4::text))
     WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, rkey, voterDid],
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

describe('Governance decision records and vote-record tallies', () => {
  let plcAvailable: boolean;
  let owner: User;
  let voter1: User;
  let voter2: User;
  let communityDid: string;

  const QUORUM = 3;
  const GHOST_VOTER = 'did:plc:ghostvoter0000000000000';

  async function createProposal(targetRkey: string) {
    const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: TARGET_COLLECTION,
      targetRkey,
      action: 'write',
      proposedRecord: { value: targetRkey },
    });
    expect(res.status).toBe(200);
    return res.body as { uri: string; cid: string; rkey: string };
  }

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('dec-owner'));
    voter1 = await createTestUser(uniqueHandle('dec-voter1'));
    voter2 = await createTestUser(uniqueHandle('dec-voter2'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('dec-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    expect(createRes.status).toBe(201);
    communityDid = createRes.body.did;

    const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    const modRoleRkey = rolesRes.body.roles.find((r: any) => r.name === 'moderator').rkey;

    for (const member of [voter1, voter2]) {
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: modRoleRkey,
      });
    }

    const modelRes = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: QUORUM, voterRole: 'moderator', proposalTtlDays: 7 },
    });
    expect(modelRes.status).toBe(200);
  });

  describe('the proposer seed vote produces a record', () => {
    let created: { cid: string; rkey: string };

    it('writes a voter-signed record for the vote createProposal seeds', async () => {
      if (!plcAvailable) return;
      created = await createProposal('seed-vote');

      const record = await voteRecordOf(owner, created.rkey);
      expect(record).toBeTruthy();
      expect(record!.value.vote).toBe('for');
      expect(record!.value.community).toBe(communityDid);
      // Cites the proposal exactly as created.
      expect(record!.value.proposal.cid).toBe(created.cid);
      expect(record!.uri.startsWith(`at://${owner.did}/`)).toBe(true);
    });

    it('marks the proposal as decided from vote records', async () => {
      if (!plcAvailable) return;
      const proposal = await getProposal(communityDid, created.rkey);
      expect(proposal.evidenceModel).toBe('vote-records');
      expect(proposal.cidChain).toEqual([]);
      expect(proposal.votesFor).toEqual([owner.did]);
    });

    it('audits the creation with its evidence references', async () => {
      if (!plcAvailable) return;
      const [meta] = await auditEntries('community.proposal.create', communityDid, created.rkey);
      expect(meta.proposalCid).toBe(created.cid);
      expect(meta.evidenceModel).toBe('vote-records');
      expect(meta.proposerVoteUri).toContain(`at://${owner.did}/${VOTE_COLLECTION}/`);
      expect(meta.proposerVoteCid).toBeTruthy();
    });
  });

  describe('propose → vote → resolve writes a decision citing its evidence', () => {
    let proposalRkey: string;
    let proposalCidAtResolution: string;
    let decision: { uri: string; cid: string; value: any };

    it('resolves once the counted vote records reach quorum', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('approved-1');
      proposalRkey = created.rkey;

      const first = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ recorded: true, status: 'open' });

      // The state the last voter attests to, before the resolution rewrite.
      proposalCidAtResolution = await getProposalCid(communityDid, proposalRkey);

      const second = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('approved');
      expect(second.body.applied).toBe(true);
    });

    it('writes exactly one decision record, retrievable through the repo API', async () => {
      if (!plcAvailable) return;
      const matches = await decisionFor(communityDid, owner.accessJwt, proposalRkey);
      expect(matches.length).toBe(1);
      decision = matches[0];

      const rkey = decision.uri.split('/').pop()!;
      const direct = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: DECISION_COLLECTION, rkey,
      });
      expect(direct.status).toBe(200);
      expect(direct.body.cid).toBe(decision.cid);

      // ...and it is a real signed record in the community MST, not a cache row.
      const fromMst = await readFromMst(communityDid, DECISION_COLLECTION, rkey) as any;
      expect(fromMst).toBeTruthy();
      expect(fromMst.outcome).toBe('approved');
      expect(fromMst.proposalRkey).toBe(proposalRkey);
    });

    it('cites the proposal CID, the quorum rule and the outcome', async () => {
      if (!plcAvailable) return;
      const value = decision.value;
      expect(value.$type).toBe(DECISION_COLLECTION);
      expect(value.community).toBe(communityDid);
      expect(value.proposal.uri).toBe(`at://${communityDid}/${PROPOSAL_COLLECTION}/${proposalRkey}`);
      expect(value.proposal.cid).toBe(proposalCidAtResolution);
      expect(value.proposalCollection).toBe(PROPOSAL_COLLECTION);
      expect(value.outcome).toBe('approved');
      expect(value.quorum).toMatchObject({ model: 'simple-majority', threshold: QUORUM });
      expect(value.quorum.rule).toBeTruthy();
      expect(value.tally).toEqual({ votesFor: 3, votesAgainst: 0, total: 3 });
      expect(value.evidenceComplete).toBe(true);
      expect(value.uncountedVotes).toBeUndefined();
      expect(value.action).toEqual({
        targetCollection: TARGET_COLLECTION, targetRkey: 'approved-1', action: 'write',
      });
      expect(value.resolvedAt).toBeTruthy();
    });

    it('cites the CID of every counted vote record, as held in the voters own repos', async () => {
      if (!plcAvailable) return;
      const cited = decision.value.votes as Array<any>;
      expect(cited.length).toBe(3);

      for (const voter of [owner, voter1, voter2]) {
        const held = await voteRecordOf(voter, proposalRkey);
        expect(held).toBeTruthy();
        const citation = cited.find(v => v.voter === voter.did);
        expect(citation).toBeTruthy();
        // The citation must match the record actually in the voter's repo.
        expect(citation.record.uri).toBe(held!.uri);
        expect(citation.record.cid).toBe(held!.cid);
        expect(citation.vote).toBe('for');
        expect(citation.proposalCid).toBe(held!.value.proposal.cid);
      }
    });

    it('links the resolved proposal and the applied change to the decision', async () => {
      if (!plcAvailable) return;
      const proposal = await getProposal(communityDid, proposalRkey);
      expect(proposal.status).toBe('approved');
      expect(proposal.decision.uri).toBe(decision.uri);
      expect(proposal.decision.cid).toBe(decision.cid);

      const applied = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'approved-1',
      });
      expect(applied.status).toBe(200);
      expect(applied.body.value.value).toBe('approved-1');

      const [meta] = await auditEntries('community.proposal.approve', communityDid, proposalRkey);
      expect(meta.applied).toBe(true);
      expect(meta.decisionUri).toBe(decision.uri);
      expect(meta.decisionCid).toBe(decision.cid);
      expect(meta.evidenceComplete).toBe(true);
      expect(meta.countedVoteCids.length).toBe(3);
      for (const citation of decision.value.votes) {
        expect(meta.countedVoteCids).toContain(citation.record.cid);
      }
    });

    it('audits each vote with the records it produced', async () => {
      if (!plcAvailable) return;
      const metas = await auditEntries('community.proposal.vote', communityDid, proposalRkey);
      expect(metas.length).toBe(2);
      for (const meta of metas) {
        expect(meta.voteRecords.length).toBe(1);
        expect(meta.voteRecords[0].uri).toContain(VOTE_COLLECTION);
        expect(meta.proposalCid).toBeTruthy();
      }
    });
  });

  describe('a cache-only vote never changes an outcome', () => {
    let proposalRkey: string;

    it('defers resolution when the cache reaches quorum but the records do not', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('diverged-1');
      proposalRkey = created.rkey;

      // A counted vote with no record behind it: cache says 2 for, records say 1.
      await injectCacheOnlyVote(communityDid, proposalRkey, GHOST_VOTER);

      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'against',
      });
      expect(res.status).toBe(200);
      // Cache: 2 for / 1 against = quorum, would have approved.
      // Records: 1 for / 1 against = below quorum. The two disagree, so nothing
      // is decided and nothing is applied.
      expect(res.body.status).toBe('open');
      expect(res.body.applied).toBeUndefined();
      expect(res.body.resolutionDeferred).toBe(true);

      expect((await decisionFor(communityDid, owner.accessJwt, proposalRkey)).length).toBe(0);
      const applied = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'diverged-1',
      });
      expect(applied.status).toBe(404);
    });

    it('audits the deferral with the votes that had no record', async () => {
      if (!plcAvailable) return;
      const [meta] = await auditEntries('community.proposal.resolution.deferred', communityDid, proposalRkey);
      expect(meta.recordOutcome).toBeNull();
      expect(meta.cacheOutcome).toBe('approved');
      expect(meta.countedFor).toBe(1);
      expect(meta.countedAgainst).toBe(1);
      expect(meta.uncountedVotes).toEqual([
        { voter: GHOST_VOTER, vote: 'for', reason: 'no-vote-record' },
      ]);
    });

    it('resolves on the records once both tallies agree, enumerating the gap', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, {
        communityDid, proposalRkey, vote: 'against',
      });
      expect(res.status).toBe(200);
      // Records: 1 for / 2 against -> rejected. Cache: 2 for / 2 against ->
      // also rejected. Same outcome, so the divergence changes nothing.
      expect(res.body.status).toBe('rejected');
      expect(res.body.resolutionDeferred).toBeUndefined();

      const matches = await decisionFor(communityDid, owner.accessJwt, proposalRkey);
      expect(matches.length).toBe(1);
      const value = matches[0].value;
      expect(value.outcome).toBe('rejected');
      expect(value.tally).toEqual({ votesFor: 1, votesAgainst: 2, total: 3 });
      expect(value.evidenceComplete).toBe(false);
      expect(value.uncountedVotes).toEqual([
        { voter: GHOST_VOTER, vote: 'for', reason: 'no-vote-record' },
      ]);
      // The unrecorded vote is named, never counted.
      expect(value.votes.map((v: any) => v.voter)).not.toContain(GHOST_VOTER);

      const applied = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'diverged-1',
      });
      expect(applied.status).toBe(404);
    });
  });

  describe('in-flight proposals complete under the old mechanics', () => {
    it('resolves a pre-upgrade proposal from its arrays and writes no decision', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('legacy-1');
      const proposalRkey = created.rkey;

      // Strip the evidence marker to reproduce a proposal that was already open
      // when this change shipped: votes in the arrays, none of them backed by a
      // record the tally would count.
      await query(
        `UPDATE records_index SET record = (record - 'evidenceModel' - 'cidChain')
         WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
        [communityDid, PROPOSAL_COLLECTION, proposalRkey],
      );
      await injectCacheOnlyVote(communityDid, proposalRkey, GHOST_VOTER);

      const proposal = await getProposal(communityDid, proposalRkey);
      expect(proposal.evidenceModel).toBeUndefined();

      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(res.status).toBe(200);
      // Old mechanics: three names in votesFor is quorum, regardless of records.
      expect(res.body.status).toBe('approved');
      expect(res.body.applied).toBe(true);
      expect(res.body.resolutionDeferred).toBeUndefined();

      expect((await decisionFor(communityDid, owner.accessJwt, proposalRkey)).length).toBe(0);
      const resolved = await getProposal(communityDid, proposalRkey);
      expect(resolved.decision).toBeUndefined();

      const applied = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'legacy-1',
      });
      expect(applied.status).toBe(200);
    });
  });

  describe('a vote that cannot be recorded is refused, not counted', () => {
    let noRepoVoter: User;

    beforeAll(async () => {
      if (!plcAvailable) return;

      noRepoVoter = await createTestUser(uniqueHandle('dec-norepo'));
      const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
      const modRoleRkey = rolesRes.body.roles.find((r: any) => r.name === 'moderator').rkey;
      await xrpcAuthPost('net.openfederation.community.join', noRepoVoter.accessJwt, { did: communityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid, memberDid: noRepoVoter.did, roleRkey: modRoleRkey,
      });

      // Reproduce an account that can never sign a vote record — an external
      // user or the bootstrap admin — by removing its repo root.
      await query('DELETE FROM repo_roots WHERE did = $1', [noRepoVoter.did]);
    });

    it('refuses the vote instead of adding an unbacked name to the cache', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('norepo-1');

      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', noRepoVoter.accessJwt, {
        communityDid, proposalRkey: created.rkey, vote: 'for',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VoteNotRecordable');

      // The tally is untouched, so this community can still reach quorum.
      const proposal = await getProposal(communityDid, created.rkey);
      expect(proposal.votesFor).toEqual([owner.did]);
      expect(proposal.votesAgainst ?? []).toEqual([]);
      expect(proposal.status).toBe('open');
    });

    it('seeds no proposer vote when the proposer cannot record one', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createProposal', noRepoVoter.accessJwt, {
        communityDid,
        targetCollection: TARGET_COLLECTION,
        targetRkey: 'norepo-proposer',
        action: 'write',
        proposedRecord: { value: 'norepo-proposer' },
      });
      expect(res.status).toBe(200);

      const proposal = await getProposal(communityDid, res.body.rkey);
      expect(proposal.votesFor).toEqual([]);
      expect(proposal.evidenceModel).toBe('vote-records');

      const [meta] = await auditEntries('community.proposal.create', communityDid, res.body.rkey);
      expect(meta.seedVote).toBe(false);
      expect(meta.proposerVoteUri).toBeUndefined();
    });

    it('still reaches quorum from the voters who can record', async () => {
      if (!plcAvailable) return;
      // Cache and records agree at every step now, so nothing defers.
      const created = await createProposal('norepo-quorum');
      const first = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey: created.rkey, vote: 'for',
      });
      expect(first.body.status).toBe('open');
      const second = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, {
        communityDid, proposalRkey: created.rkey, vote: 'for',
      });
      expect(second.body.status).toBe('approved');
      expect(second.body.applied).toBe(true);
      expect(second.body.resolutionDeferred).toBeUndefined();
    });
  });

  describe('a transient record failure defers instead of resolving', () => {
    it('never resolves and never applies when a counted vote lost its record', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('transient-1');
      const proposalRkey = created.rkey;

      const first = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(first.body.status).toBe('open');

      // The residual case the up-front check cannot cover: hasRepo() was true,
      // the vote was counted into the cache, and the commit did not survive.
      const held = await voteRecordOf(voter1, proposalRkey);
      await query(
        `DELETE FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
        [voter1.did, VOTE_COLLECTION, held!.uri.split('/').pop()],
      );

      const second = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(second.status).toBe(200);
      // Cache: 3 for = quorum. Records: 2 for = below quorum. Deferred.
      expect(second.body.status).toBe('open');
      expect(second.body.applied).toBeUndefined();
      expect(second.body.resolutionDeferred).toBe(true);

      expect((await decisionFor(communityDid, owner.accessJwt, proposalRkey)).length).toBe(0);
      const applied = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'transient-1',
      });
      expect(applied.status).toBe(404);
      const resolved = await getProposal(communityDid, proposalRkey);
      expect(resolved.status).toBe('open');
      expect(resolved.decision).toBeUndefined();

      const [deferral] = await auditEntries('community.proposal.resolution.deferred', communityDid, proposalRkey);
      expect(deferral.recordOutcome).toBeNull();
      expect(deferral.cacheOutcome).toBe('approved');
      expect(deferral.uncountedVotes).toEqual([
        { voter: voter1.did, vote: 'for', reason: 'no-vote-record' },
      ]);
    });
  });

  describe('a retried resolution never reuses a contradicting decision', () => {
    it('supersedes the stale decision instead of citing it for a different outcome', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('supersede-1');
      const proposalRkey = created.rkey;

      await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      const resolveRes = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(resolveRes.body.status).toBe('approved');

      const [original] = await decisionFor(communityDid, owner.accessJwt, proposalRkey);
      expect(original.value.outcome).toBe('approved');

      const engine = new RepoEngine(communityDid);
      const keypair = await getKeypairForDid(communityDid);
      const proposal = await getProposal(communityDid, proposalRkey);
      const proposalCid = await getProposalCid(communityDid, proposalRkey);

      // Same proposal, same call — but the tally has moved, as it can after a
      // crash between the decision write and the status rewrite.
      const same = await ensureDecisionRecord({
        engine, keypair, communityDid, proposalRkey, proposalCid, proposal,
        tally: { votesFor: [], votesAgainst: [], uncounted: [] },
        quorum: quorumRule('simple-majority', QUORUM),
        outcome: 'approved',
      });
      expect(same.uri).toBe(original.uri);
      expect(same.cid).toBe(original.cid);

      const superseding = await ensureDecisionRecord({
        engine, keypair, communityDid, proposalRkey, proposalCid, proposal,
        tally: { votesFor: [], votesAgainst: [], uncounted: [] },
        quorum: quorumRule('simple-majority', QUORUM),
        outcome: 'rejected',
      });
      expect(superseding.uri).not.toBe(original.uri);

      const decisions = await decisionFor(communityDid, owner.accessJwt, proposalRkey);
      expect(decisions.length).toBe(2);
      const fresh = decisions.find(d => d.uri === superseding.uri)!;
      expect(fresh.value.outcome).toBe('rejected');
      expect(fresh.value.supersedes).toEqual({ uri: original.uri, cid: original.cid });

      const [audit] = await auditEntries('community.proposal.decision.superseded', communityDid, proposalRkey);
      expect(audit.supersededUri).toBe(original.uri);
      expect(audit.previousOutcome).toBe('approved');
      expect(audit.outcome).toBe('rejected');
    });
  });

  describe('proposal CID lineage', () => {
    it('grows as votes rewrite the proposal, keeping earlier citations checkable', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('lineage-1');
      const proposalRkey = created.rkey;

      await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });

      const proposal = await getProposal(communityDid, proposalRkey);
      expect(proposal.cidChain).toContain(created.cid);
      // The proposer's citation is still resolvable against the lineage.
      const seed = await voteRecordOf(owner, proposalRkey);
      expect(proposal.cidChain).toContain(seed!.value.proposal.cid);
    });

    it('refuses a vote record citing a proposal state that never existed', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('forged-1');
      const proposalRkey = created.rkey;

      // Rewrite the proposer's vote record so it cites a CID outside the
      // proposal's lineage — the shape of a fabricated vote.
      const seed = await voteRecordOf(owner, proposalRkey);
      const seedRkey = seed!.uri.split('/').pop()!;
      await query(
        `UPDATE records_index
         SET record = jsonb_set(record, '{proposal,cid}', '"bafyreiforgedforgedforgedforgedforgedforgedforgedforgedforged"')
         WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
        [owner.did, VOTE_COLLECTION, seedRkey],
      );

      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('open');

      // The forged citation is excluded, so the proposer's cached vote shows up
      // as unbacked instead of silently counting.
      const [meta] = await auditEntries('community.proposal.resolution.deferred', communityDid, proposalRkey);
      expect(meta).toBeUndefined();

      const withVoter2 = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(withVoter2.status).toBe(200);
      // Cache: 3 for -> approved. Records: 2 countable -> below quorum. Deferred.
      expect(withVoter2.body.status).toBe('open');
      expect(withVoter2.body.resolutionDeferred).toBe(true);

      const [deferral] = await auditEntries('community.proposal.resolution.deferred', communityDid, proposalRkey);
      expect(deferral.uncountedVotes).toEqual([
        { voter: owner.did, vote: 'for', reason: 'unknown-proposal-cid' },
      ]);
    });
  });
});
