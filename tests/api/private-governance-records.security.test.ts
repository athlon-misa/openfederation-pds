/**
 * Votes and objections in a private community stay in the community: they are
 * stored in the community's own repository, signed by the voter, and the
 * offline verifier accepts them there. A public community keeps them in the
 * voter's own repository, as before.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { buildVerifyInput, findDecisions, parseRepoCar } from '../../src/governance/decision-evidence.js';
import { verifyDecision } from '../../src/governance/verify-decision.js';

type User = { accessJwt: string; did: string; handle: string };
const VOTE = 'net.openfederation.governance.vote';
const OBJECTION = 'net.openfederation.governance.objection';
const TARGET = 'net.openfederation.community.metadata';

async function exportCar(did: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await new RepoEngine(did).exportAsCAR()) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
async function didDocument(did: string): Promise<any> {
  const res = await fetch(`${process.env.PLC_DIRECTORY_URL || 'http://localhost:2582'}/${did}`);
  return res.json();
}
const governanceRecordsIn = async (repo: string, collection: string, community: string) => (await query<{ rkey: string; record: any }>(
  `SELECT rkey, record FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>'community' = $3`,
  [repo, collection, community])).rows;

describe('governance records in private communities', () => {
  let plc: boolean;
  let owner: User, v1: User, v2: User;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('pgr-owner'));
    v1 = await createTestUser(uniqueHandle('pgr-v1'));
    v2 = await createTestUser(uniqueHandle('pgr-v2'));
  });

  async function votingCommunity(visibility: 'public' | 'private', timelockHours = 0): Promise<string> {
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('pgr'), didMethod: 'plc', visibility, joinPolicy: 'open',
    });
    const did = created.body.did;
    const roles = await xrpcGet('net.openfederation.community.listRoles', { communityDid: did }).set('Authorization', `Bearer ${owner.accessJwt}`);
    const moderator = roles.body.roles.find((r: any) => r.name === 'moderator').rkey;
    for (const u of [v1, v2]) {
      expect((await xrpcAuthPost('net.openfederation.community.join', u.accessJwt, { did })).body.status).toBe('joined');
      expect((await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid: did, memberDid: u.did, roleRkey: moderator,
      })).status).toBe(200);
    }
    const model = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid: did, governanceModel: 'simple-majority',
      governanceConfig: { quorum: 3, voterRole: 'moderator', proposalTtlDays: 7, timelockHours },
    });
    expect(model.status).toBe(200);
    return did;
  }

  async function passProposal(community: string, targetRkey: string): Promise<string> {
    const p = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid: community, targetCollection: TARGET, targetRkey, action: 'write', proposedRecord: { value: targetRkey },
    });
    expect(p.status).toBe(200);
    for (const u of [v1, v2]) {
      const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', u.accessJwt, {
        communityDid: community, proposalRkey: p.body.rkey, vote: 'for',
      });
      expect(vote.status).toBe(200);
    }
    return p.body.rkey;
  }

  describe('a private community', () => {
    let community: string;
    let proposalRkey: string;

    beforeAll(async () => {
      if (!plc) return;
      community = await votingCommunity('private');
      proposalRkey = await passProposal(community, 'private-vote');
    });

    it('stores every vote in the community repository, signed by its voter, and none in voters\' repositories', async () => {
      if (!plc) return;
      for (const u of [owner, v1, v2]) {
        expect(await governanceRecordsIn(u.did, VOTE, community)).toHaveLength(0);
      }
      const votes = (await governanceRecordsIn(community, VOTE, community)).filter((r) => r.record.proposalRkey === proposalRkey);
      expect(votes.map((r) => r.record.author).sort()).toEqual([owner.did, v1.did, v2.did].sort());
      for (const r of votes) expect(r.record.authorSig?.sig).toBeTruthy();
    });

    it('still resolves the proposal from those records', async () => {
      if (!plc) return;
      const proposal = (await query<{ record: any }>(
        `SELECT record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.community.proposal' AND rkey = $2`,
        [community, proposalRkey])).rows[0].record;
      expect(proposal.status).toBe('approved');
    });

    it('produces a decision the offline verifier accepts from the community export alone', async () => {
      if (!plc) return;
      const repos = [await parseRepoCar(await exportCar(community))];
      const didDocuments = [];
      for (const did of [community, owner.did, v1.did, v2.did]) didDocuments.push(await didDocument(did));
      const decision = findDecisions(repos).find((d) => d.proposalRkey === proposalRkey);
      expect(decision).toBeTruthy();
      const verdict = await verifyDecision(buildVerifyInput(decision!, repos, didDocuments));
      expect(verdict.problems).toEqual([]);
      expect(verdict.status).toBe('valid');
      expect(verdict.summary.verifiedVotes).toBe(3);
    });

    it('rejects a vote in the community repository whose signature is not its voter\'s', async () => {
      if (!plc) return;
      const repos = [await parseRepoCar(await exportCar(community))];
      // Give the verifier a DID document for v1 that names a different key.
      const didDocuments = [];
      for (const did of [community, owner.did, v1.did, v2.did]) {
        const doc = await didDocument(did);
        if (did === v1.did) {
          const wrong = await didDocument(owner.did);
          doc.verificationMethod = wrong.verificationMethod.map((m: any) => ({ ...m, id: m.id.replace(owner.did, v1.did), controller: v1.did }));
        }
        didDocuments.push(doc);
      }
      const decision = findDecisions(repos).find((d) => d.proposalRkey === proposalRkey);
      const verdict = await verifyDecision(buildVerifyInput(decision!, repos, didDocuments));
      expect(verdict.status).toBe('invalid');
      expect(verdict.problems.some((p) => p.voter === v1.did)).toBe(true);
    });

    it('stores an objection in the community repository, signed by the objector', async () => {
      if (!plc) return;
      const held = await votingCommunity('private', 48);
      const rkey = await passProposal(held, 'private-objection');
      const objected = await xrpcAuthPost('net.openfederation.community.objectToProposal', v1.accessJwt, {
        communityDid: held, proposalRkey: rkey, reason: 'not yet',
      });
      expect(objected.status).toBe(200);
      expect(await governanceRecordsIn(v1.did, OBJECTION, held)).toHaveLength(0);
      const objections = await governanceRecordsIn(held, OBJECTION, held);
      expect(objections).toHaveLength(1);
      expect(objections[0].record.author).toBe(v1.did);
      const proposal = (await query<{ record: any }>(
        `SELECT record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.community.proposal' AND rkey = $2`,
        [held, rkey])).rows[0].record;
      expect(['objected', 'objection-override']).toContain(proposal.status);
    });
  });

  it('a public community keeps votes in voters\' own repositories', async () => {
    if (!plc) return;
    const community = await votingCommunity('public');
    const rkey = await passProposal(community, 'public-vote');
    expect((await governanceRecordsIn(v1.did, VOTE, community)).filter((r) => r.record.proposalRkey === rkey)).toHaveLength(1);
    expect((await governanceRecordsIn(community, VOTE, community))).toHaveLength(0);
  });

  it('a community that becomes private moves the votes still in play, and leaves decided ones where their decision cites them', async () => {
    if (!plc) return;
    const community = await votingCommunity('public');
    const decided = await passProposal(community, 'decided-before');
    const open = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid: community, targetCollection: TARGET, targetRkey: 'still-open', action: 'write', proposedRecord: { value: 'x' },
    });
    expect(open.status).toBe(200);
    expect((await xrpcAuthPost('net.openfederation.community.voteOnProposal', v1.accessJwt, {
      communityDid: community, proposalRkey: open.body.rkey, vote: 'for',
    })).status).toBe(200);

    // A voting community changes its visibility the way it changes any setting: by proposal.
    const settings = (await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [community])).rows[0].record;
    const makePrivate = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid: community, targetCollection: 'net.openfederation.community.settings', targetRkey: 'self',
      action: 'write', proposedRecord: { ...settings, visibility: 'private' },
    });
    expect(makePrivate.status).toBe(200);
    for (const u of [v1, v2]) {
      expect((await xrpcAuthPost('net.openfederation.community.voteOnProposal', u.accessJwt, {
        communityDid: community, proposalRkey: makePrivate.body.rkey, vote: 'for',
      })).status).toBe(200);
    }
    const nowSettings = (await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [community])).rows[0].record;
    expect(nowSettings.visibility).toBe('private');

    // The open proposal's votes moved, signed, into the community repo...
    const openVotesInUserRepos = [];
    for (const u of [owner, v1]) {
      openVotesInUserRepos.push(...(await governanceRecordsIn(u.did, VOTE, community)).filter((r) => r.record.proposalRkey === open.body.rkey));
    }
    expect(openVotesInUserRepos).toHaveLength(0);
    const moved = (await governanceRecordsIn(community, VOTE, community)).filter((r) => r.record.proposalRkey === open.body.rkey);
    expect(moved.map((r) => r.record.author).sort()).toEqual([owner.did, v1.did].sort());

    // ...and still count: the third vote resolves it.
    expect((await xrpcAuthPost('net.openfederation.community.voteOnProposal', v2.accessJwt, {
      communityDid: community, proposalRkey: open.body.rkey, vote: 'for',
    })).status).toBe(200);
    const proposal = (await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.community.proposal' AND rkey = $2`,
      [community, open.body.rkey])).rows[0].record;
    expect(proposal.status).toBe('approved');

    // The decided proposal's votes stay put: its signed decision cites them there.
    expect((await governanceRecordsIn(v1.did, VOTE, community)).filter((r) => r.record.proposalRkey === decided)).toHaveLength(1);
  });
});
