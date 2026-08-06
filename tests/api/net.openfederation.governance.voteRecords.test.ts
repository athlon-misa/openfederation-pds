import { describe, it, expect, beforeAll } from 'vitest';
import { Repo } from '@atproto/repo';
import {
  xrpcGet, xrpcAuthGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { PgBlockstore } from '../../src/repo/pg-blockstore.js';
import { query } from '../../src/db/client.js';
import { writeVoteRecord } from '../../src/governance/vote-records.js';

const VOTE_COLLECTION = 'net.openfederation.governance.vote';
const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const DELEGATION_COLLECTION = 'net.openfederation.community.delegation';

type User = { accessJwt: string; did: string; handle: string };

/** Read a record straight out of the MST (not the records_index cache). */
async function readFromMst(did: string, collection: string, rkey: string) {
  const repo = await Repo.load(new PgBlockstore(did));
  return repo.getRecord(collection, rkey);
}

async function listVoteRecords(voter: User) {
  const res = await xrpcAuthGet('com.atproto.repo.listRecords', voter.accessJwt, {
    repo: voter.did,
    collection: VOTE_COLLECTION,
  });
  expect(res.status).toBe(200);
  return res.body.records as Array<{ uri: string; cid: string; value: any }>;
}

async function getProposalCid(communityDid: string, rkey: string): Promise<string> {
  const res = await xrpcGet('com.atproto.repo.getRecord', {
    repo: communityDid, collection: PROPOSAL_COLLECTION, rkey,
  });
  expect(res.status).toBe(200);
  return res.body.cid;
}

describe('Voter-signed governance vote records', () => {
  let plcAvailable: boolean;
  let owner: User;
  let directVoter: User;
  let delegate: User;
  let delegator: User;
  let communityDid: string;
  let proposalRkey: string;
  let proposalCidBeforeDirectVote: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('vr-owner'));
    directVoter = await createTestUser(uniqueHandle('vr-direct'));
    delegate = await createTestUser(uniqueHandle('vr-delegate'));
    delegator = await createTestUser(uniqueHandle('vr-delegator'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('vr-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    expect(createRes.status).toBe(201);
    communityDid = createRes.body.did;

    const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    const modRoleRkey = rolesRes.body.roles.find((r: any) => r.name === 'moderator').rkey;

    for (const member of [directVoter, delegate, delegator]) {
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: modRoleRkey,
      });
    }

    // High quorum keeps the proposal open across every vote in this suite.
    const modelRes = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: 10, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
    });
    expect(modelRes.status).toBe(200);

    const proposalRes = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: 'net.openfederation.community.profile',
      targetRkey: 'self',
      action: 'write',
      proposedRecord: { displayName: 'Vote Record Community' },
    });
    expect(proposalRes.status).toBe(200);
    proposalRkey = proposalRes.body.rkey;
  });

  describe('direct votes', () => {
    it('writes a signed vote record into the voter repo', async () => {
      if (!plcAvailable) return;

      proposalCidBeforeDirectVote = await getProposalCid(communityDid, proposalRkey);

      const voteRes = await xrpcAuthPost('net.openfederation.community.voteOnProposal', directVoter.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      // Endpoint response shape is unchanged by the dual-write.
      expect(voteRes.status).toBe(200);
      expect(voteRes.body).toEqual({ recorded: true, status: 'open' });

      const records = await listVoteRecords(directVoter);
      expect(records.length).toBe(1);

      const value = records[0].value;
      expect(value.$type).toBe(VOTE_COLLECTION);
      expect(value.community).toBe(communityDid);
      expect(value.vote).toBe('for');
      expect(value.proposalCollection).toBe(PROPOSAL_COLLECTION);
      expect(value.proposalRkey).toBe(proposalRkey);
      expect(value.proposal.uri).toBe(`at://${communityDid}/${PROPOSAL_COLLECTION}/${proposalRkey}`);
      expect(value.proposal.cid).toBe(proposalCidBeforeDirectVote);
      expect(value.createdAt).toBeTruthy();
      // Direct vote: no delegation provenance.
      expect(value.castBy).toBeUndefined();
      expect(value.delegation).toBeUndefined();
    });

    it('commits the vote record to the voter MST, not just the read cache', async () => {
      if (!plcAvailable) return;

      const records = await listVoteRecords(directVoter);
      const rkey = records[0].uri.split('/').pop()!;

      const fromMst = await readFromMst(directVoter.did, VOTE_COLLECTION, rkey) as any;
      expect(fromMst).toBeTruthy();
      expect(fromMst.vote).toBe('for');
      expect(fromMst.proposalRkey).toBe(proposalRkey);
      expect(fromMst.proposal.cid).toBe(proposalCidBeforeDirectVote);
    });

    it('includes the vote record in the account export', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthGet('net.openfederation.account.export', directVoter.accessJwt, {
        did: directVoter.did,
      });
      expect(res.status).toBe(200);
      const exported = res.body.collections[VOTE_COLLECTION];
      expect(exported.length).toBe(1);
      expect(exported[0].record.proposalRkey).toBe(proposalRkey);
    });

    it('rejects a duplicate vote and writes no second record', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', directVoter.accessJwt, {
        communityDid, proposalRkey, vote: 'against',
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('AlreadyVoted');

      const records = await listVoteRecords(directVoter);
      expect(records.length).toBe(1);
      expect(records[0].value.vote).toBe('for');
    });

    it('refuses self-authored vote records through the generic repo endpoint', async () => {
      if (!plcAvailable) return;

      const res = await xrpcAuthPost('com.atproto.repo.createRecord', directVoter.accessJwt, {
        repo: directVoter.did,
        collection: VOTE_COLLECTION,
        record: {
          community: communityDid,
          proposal: { uri: `at://${communityDid}/${PROPOSAL_COLLECTION}/${proposalRkey}`, cid: proposalCidBeforeDirectVote },
          proposalCollection: PROPOSAL_COLLECTION,
          proposalRkey,
          vote: 'against',
          createdAt: new Date().toISOString(),
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UseDedicatedEndpoint');

      const records = await listVoteRecords(directVoter);
      expect(records.length).toBe(1);
    });
  });

  describe('unwritable voter repos leave an audit trail', () => {
    /**
     * Audit rows for one voter, scoped to this run's community.
     *
     * `audit_log` is never truncated between runs, so a query keyed only on the
     * action and a fixed voter DID accumulates a row per run and an
     * `expect(length).toBe(1)` starts failing the second time the suite meets
     * the same database (#203). Scoping by the community — which is created
     * fresh per run — makes the count mean "this run" rather than "since the
     * database was created".
     */
    async function auditEntriesFor(voterDid: string) {
      const res = await query<{ actor_id: string; target_id: string; meta: any }>(
        `SELECT actor_id, target_id, meta FROM audit_log
          WHERE action = 'community.proposal.vote.recordFailed'
            AND target_id = $1
            AND meta->>'voterDid' = $2
          ORDER BY created_at`,
        [communityDid, voterDid],
      );
      return res.rows;
    }

    /**
     * The DIDs below stand in for accounts that cannot sign, so they are never
     * registered and cannot come from `createTestUser`. Making them unique per
     * run keeps two runs against one database from colliding even before the
     * community scope applies.
     */
    const unsignableDid = (label: string) =>
      `did:plc:${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    it('audits a counted vote whose voter has no repo', async () => {
      if (!plcAvailable) return;

      const voterWithoutRepo = unsignableDid('norepo');
      const result = await writeVoteRecord({
        voterDid: voterWithoutRepo,
        communityDid,
        proposalRkey,
        proposalCid: proposalCidBeforeDirectVote,
        vote: 'for',
      });

      expect(result).toBeNull();
      const entries = await auditEntriesFor(voterWithoutRepo);
      expect(entries.length).toBe(1);
      expect(entries[0].actor_id).toBe(voterWithoutRepo);
      expect(entries[0].target_id).toBe(communityDid);
      expect(entries[0].meta.reason).toBe('no-repo');
      expect(entries[0].meta.proposalRkey).toBe(proposalRkey);
      expect(entries[0].meta.vote).toBe('for');
    });

    it('audits a counted vote whose repo write fails', async () => {
      if (!plcAvailable) return;

      // A DID that reports a repo but has no signing key, so the write throws
      // instead of taking the no-repo path.
      const brokenSigner = unsignableDid('nokey');
      const rootRes = await query<{ root_cid: string; rev: string }>(
        'SELECT root_cid, rev FROM repo_roots WHERE did = $1',
        [directVoter.did],
      );
      await query(
        `INSERT INTO repo_roots (did, root_cid, rev) VALUES ($1, $2, $3)
         ON CONFLICT (did) DO NOTHING`,
        [brokenSigner, rootRes.rows[0].root_cid, rootRes.rows[0].rev],
      );

      const result = await writeVoteRecord({
        voterDid: brokenSigner,
        communityDid,
        proposalRkey,
        proposalCid: proposalCidBeforeDirectVote,
        vote: 'against',
        castBy: delegate.did,
      });

      expect(result).toBeNull();
      const entries = await auditEntriesFor(brokenSigner);
      expect(entries.length).toBe(1);
      expect(entries[0].target_id).toBe(communityDid);
      expect(entries[0].meta.reason).toBeTruthy();
      expect(entries[0].meta.reason).not.toBe('no-repo');
      expect(entries[0].meta.castBy).toBe(delegate.did);
    });
  });

  describe('delegated votes', () => {
    let delegationRkey: string;
    let proposalCidBeforeDelegateVote: string;

    it('writes a record in both the delegate and delegator repos', async () => {
      if (!plcAvailable) return;

      const delRes = await xrpcAuthPost('net.openfederation.community.setDelegation', delegator.accessJwt, {
        communityDid, delegateDid: delegate.did,
      });
      expect(delRes.status).toBe(200);
      delegationRkey = delRes.body.rkey;

      proposalCidBeforeDelegateVote = await getProposalCid(communityDid, proposalRkey);

      const voteRes = await xrpcAuthPost('net.openfederation.community.voteOnProposal', delegate.accessJwt, {
        communityDid, proposalRkey, vote: 'for',
      });
      expect(voteRes.status).toBe(200);
      expect(voteRes.body).toEqual({ recorded: true, status: 'open' });

      // The delegate's own vote carries no delegation provenance.
      const delegateRecords = await listVoteRecords(delegate);
      expect(delegateRecords.length).toBe(1);
      expect(delegateRecords[0].value.castBy).toBeUndefined();
      expect(delegateRecords[0].value.delegation).toBeUndefined();
      expect(delegateRecords[0].value.vote).toBe('for');

      // The delegator gets their own record, in their own repo, attributed to
      // the delegate and pointing at the delegation that authorised it.
      const delegatorRecords = await listVoteRecords(delegator);
      expect(delegatorRecords.length).toBe(1);
      const value = delegatorRecords[0].value;
      expect(delegatorRecords[0].uri.startsWith(`at://${delegator.did}/`)).toBe(true);
      expect(value.vote).toBe('for');
      expect(value.castBy).toBe(delegate.did);
      expect(value.delegation.uri).toBe(`at://${communityDid}/${DELEGATION_COLLECTION}/${delegationRkey}`);
      expect(value.delegation.cid).toBe(delRes.body.cid);
      expect(value.proposal.cid).toBe(proposalCidBeforeDelegateVote);
    });

    it('commits the delegated vote record to the delegator MST', async () => {
      if (!plcAvailable) return;

      const records = await listVoteRecords(delegator);
      const rkey = records[0].uri.split('/').pop()!;

      const fromMst = await readFromMst(delegator.did, VOTE_COLLECTION, rkey) as any;
      expect(fromMst).toBeTruthy();
      expect(fromMst.castBy).toBe(delegate.did);
      expect(fromMst.delegation.uri).toBe(`at://${communityDid}/${DELEGATION_COLLECTION}/${delegationRkey}`);
    });

    it('leaves the authoritative tally unchanged', async () => {
      if (!plcAvailable) return;

      const res = await xrpcGet('net.openfederation.community.getProposal', {
        communityDid, rkey: proposalRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('open');
      // owner (proposer) + direct voter + delegate + delegator
      expect(res.body.votesFor).toEqual([owner.did, directVoter.did, delegate.did, delegator.did]);
      expect(res.body.votesAgainst ?? []).toEqual([]);
    });
  });
});
