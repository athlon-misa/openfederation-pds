/**
 * A failed "can this voter record?" check must never be read as "this voter has
 * no repo". Dropping a vote on a failed check removes it from the cache *and*
 * the record set at once — the two then agree without it, and the proposal
 * resolves as if the vote had never been cast. A transient database error must
 * not be able to change a governance outcome, so a failed check keeps the vote
 * counted and lets the cache/record divergence defer the resolution.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

const { failChecksFor } = vi.hoisted(() => ({ failChecksFor: new Set<string>() }));

vi.mock('../../src/governance/vote-records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/governance/vote-records.js')>();
  return {
    ...actual,
    canRecordVote: async (did: string) => {
      if (failChecksFor.has(did)) throw new Error('simulated repo lookup failure');
      return actual.canRecordVote(did);
    },
  };
});

import {
  xrpcGet, xrpcAuthGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';

const DECISION_COLLECTION = 'net.openfederation.governance.decision';
const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const TARGET_COLLECTION = 'app.example.checkfailure';

type User = { accessJwt: string; did: string; handle: string };

describe('a failed recordability check defers, it never excludes', () => {
  let plcAvailable: boolean;
  let owner: User;
  let delegate: User;
  let delegator: User;
  let communityDid: string;

  const QUORUM = 3;

  async function createProposal(targetRkey: string) {
    const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: TARGET_COLLECTION,
      targetRkey,
      action: 'write',
      proposedRecord: { value: targetRkey },
    });
    expect(res.status).toBe(200);
    return res.body as { rkey: string; cid: string };
  }

  async function getProposal(rkey: string) {
    const res = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey });
    expect(res.status).toBe(200);
    return res.body;
  }

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('cf-owner'));
    delegate = await createTestUser(uniqueHandle('cf-delegate'));
    delegator = await createTestUser(uniqueHandle('cf-delegator'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('cf-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    expect(createRes.status).toBe(201);
    communityDid = createRes.body.did;

    const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    const modRoleRkey = rolesRes.body.roles.find((r: any) => r.name === 'moderator').rkey;
    for (const member of [delegate, delegator]) {
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: modRoleRkey,
      });
    }

    await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: QUORUM, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
    });

    const delRes = await xrpcAuthPost('net.openfederation.community.setDelegation', delegator.accessJwt, {
      communityDid, delegateDid: delegate.did,
    });
    expect(delRes.status).toBe(200);
  });

  it('keeps a delegated vote counted when the delegator check fails, and defers', async () => {
    if (!plcAvailable) return;

    const created = await createProposal('checkfail-1');
    const proposalRkey = created.rkey;

    // The delegator genuinely cannot produce a record (no repo) *and* the check
    // that would have discovered that fails. The endpoint must not act on the
    // failed check: the delegator stays counted, the record write makes the real
    // determination, and the resulting divergence defers.
    await query('DELETE FROM repo_roots WHERE did = $1', [delegator.did]);
    failChecksFor.add(delegator.did);

    const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', delegate.accessJwt, {
      communityDid, proposalRkey, vote: 'for',
    });
    expect(res.status).toBe(200);

    // Counted, not dropped: cache has owner + delegate + delegator.
    const proposal = await getProposal(proposalRkey);
    expect(proposal.votesFor).toEqual([owner.did, delegate.did, delegator.did]);

    // Cache reaches quorum, records do not — so nothing resolves and nothing is
    // applied. Had the failed check dropped the vote, both tallies would have
    // read 2 and this proposal would still be open only by luck; had it dropped
    // it at quorum 2 the change would have been applied outright.
    expect(proposal.status).toBe('open');
    expect(res.body.resolutionDeferred).toBe(true);
    expect(res.body.applied).toBeUndefined();

    const decisions = await xrpcAuthGet('com.atproto.repo.listRecords', owner.accessJwt, {
      repo: communityDid, collection: DECISION_COLLECTION,
    });
    expect((decisions.body.records ?? []).length).toBe(0);

    const applied = await xrpcGet('com.atproto.repo.getRecord', {
      repo: communityDid, collection: TARGET_COLLECTION, rkey: 'checkfail-1',
    });
    expect(applied.status).toBe(404);

    // The audit names the reason the write actually established, not one the
    // failed check assumed.
    const audits = await query<{ meta: any }>(
      `SELECT meta FROM audit_log
       WHERE action = 'community.proposal.vote.recordFailed' AND meta->>'voterDid' = $1`,
      [delegator.did],
    );
    expect(audits.rows.length).toBe(1);
    expect(audits.rows[0].meta.reason).toBe('no-repo');
    expect(audits.rows[0].meta.castBy).toBe(delegate.did);

    failChecksFor.delete(delegator.did);
  });

  it('answers a direct voter whose check fails with a retryable error, not a verdict', async () => {
    if (!plcAvailable) return;

    const created = await createProposal('checkfail-2');
    failChecksFor.add(delegate.did);

    const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', delegate.accessJwt, {
      communityDid, proposalRkey: created.rkey, vote: 'for',
    });
    // Not VoteNotRecordable: no determination was made about this account.
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('InternalServerError');

    // And nothing was written, so the retry is clean.
    const proposal = await getProposal(created.rkey);
    expect(proposal.votesFor).toEqual([owner.did]);
    expect(proposal.status).toBe('open');

    failChecksFor.delete(delegate.did);

    const retry = await xrpcAuthPost('net.openfederation.community.voteOnProposal', delegate.accessJwt, {
      communityDid, proposalRkey: created.rkey, vote: 'for',
    });
    expect(retry.status).toBe(200);
    expect((await getProposal(created.rkey)).votesFor).toContain(delegate.did);
  });

  it('fails proposal creation rather than guessing when the proposer check fails', async () => {
    if (!plcAvailable) return;

    failChecksFor.add(owner.did);
    const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: TARGET_COLLECTION,
      targetRkey: 'checkfail-3',
      action: 'write',
      proposedRecord: { value: 'checkfail-3' },
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('InternalServerError');
    failChecksFor.delete(owner.did);

    // No half-written proposal: the seed vote decision is made before any write.
    const proposals = await query<{ rkey: string }>(
      `SELECT rkey FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'targetRkey' = 'checkfail-3'`,
      [communityDid, PROPOSAL_COLLECTION],
    );
    expect(proposals.rows.length).toBe(0);
  });
});
