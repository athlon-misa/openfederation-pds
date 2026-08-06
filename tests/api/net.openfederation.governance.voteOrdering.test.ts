/**
 * A decision record is byte-identical for identical evidence (#204).
 *
 * `votes` used to be emitted in Map insertion order, which followed an
 * unordered SQL scan. Nothing downstream noticed — the verifier compares CID
 * sets, and the tests normalised the sequence away — but it meant two PDSes
 * replaying the same history produced records with different CIDs, and it made
 * every decision comparison lossy.
 *
 * The tally now sorts by `voteOrderKey`: the same earliest-`createdAt`,
 * rkey-as-tiebreak ordering the one-vote-per-voter rule already applies. No new
 * notion of order, just the existing one applied to the output.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { tallyFromVoteRecords } from '../../src/governance/proposal-resolution.js';
import { voteOrderKey } from '../../src/governance/decision-rules.js';

type User = { accessJwt: string; did: string; handle: string };

describe('decision vote ordering is deterministic', () => {
  let plcAvailable = false;
  let owner: User;
  let voters: User[] = [];
  let communityDid: string;
  let proposalRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('vo-owner'));
    for (let i = 0; i < 4; i++) {
      voters.push(await createTestUser(uniqueHandle(`vo-v${i}`)));
    }

    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('vo-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
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

    // Quorum above the voter count keeps the proposal open so the tally can be
    // recomputed repeatedly without the proposal resolving out from under it.
    await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: 20, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
    });

    const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: 'net.openfederation.community.profile',
      targetRkey: 'self',
      action: 'write',
      proposedRecord: { displayName: 'Ordering' },
    });
    expect(proposal.status).toBe(200);
    proposalRkey = proposal.body.rkey;

    // Vote in a deliberately mixed order of choices so `for`/`against` grouping
    // and chronological order are distinguishable.
    for (const [i, v] of voters.entries()) {
      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', v.accessJwt, {
        communityDid, proposalRkey, vote: i % 2 === 0 ? 'for' : 'against',
      });
      expect(res.status).toBe(200);
    }
  });

  async function currentTally() {
    const proposalRes = await xrpcGet('com.atproto.repo.getRecord', {
      repo: communityDid,
      collection: 'net.openfederation.community.proposal',
      rkey: proposalRkey,
    });
    return tallyFromVoteRecords({
      communityDid,
      proposalRkey,
      proposal: proposalRes.body.value,
      proposalCid: proposalRes.body.cid,
    });
  }

  it('produces the same order every time it is recomputed', async () => {
    if (!plcAvailable) return;

    const runs = [];
    for (let i = 0; i < 5; i++) {
      const t = await currentTally();
      runs.push([...t.votesFor, ...t.votesAgainst].map(v => v.record.uri));
    }
    // Every run identical — not merely the same set.
    for (const run of runs) expect(run).toEqual(runs[0]);
    // Four voters plus the proposer's seed vote, which createProposal records.
    expect(runs[0].length).toBe(5);
  });

  it('orders each side by the same key the earliest-record rule uses', async () => {
    if (!plcAvailable) return;

    const t = await currentTally();
    for (const side of [t.votesFor, t.votesAgainst]) {
      const keys = await Promise.all(side.map(async (v) => {
        const rkey = v.record.uri.split('/').pop()!;
        const rec = await xrpcGet('com.atproto.repo.getRecord', {
          repo: v.voter, collection: 'net.openfederation.governance.vote', rkey,
        });
        return voteOrderKey(rec.body.value.createdAt, rkey);
      }));
      expect([...keys]).toEqual([...keys].sort());
    }
  });

  it('keeps for and against grouped, each chronological', async () => {
    if (!plcAvailable) return;

    const t = await currentTally();
    expect(t.votesFor.every(v => v.vote === 'for')).toBe(true);
    expect(t.votesAgainst.every(v => v.vote === 'against')).toBe(true);
    // Two `for` voters plus the proposer's seed vote; two `against`.
    expect(t.votesFor.length).toBe(3);
    expect(t.votesAgainst.length).toBe(2);
  });

  it('yields an identical decision record body across recomputations', async () => {
    if (!plcAvailable) return;

    // The property that actually matters: same evidence, same bytes, therefore
    // the same CID — which is what makes a decision reproducible by a second
    // implementation replaying the same history.
    const bodies = [];
    for (let i = 0; i < 3; i++) {
      const t = await currentTally();
      bodies.push(JSON.stringify([...t.votesFor, ...t.votesAgainst]));
    }
    expect(new Set(bodies).size).toBe(1);
  });
});
