/**
 * Anchoring tier and ratchet reframe (#198).
 *
 * `on-chain` no longer means "the chain decides". It means the community
 * decides in its own repos — the same vote records, decision record and contest
 * window every other voting community uses — and a registered attestor
 * notarizes the result afterwards. Three properties are exercised here, and the
 * middle one is the load-bearing one:
 *
 *   1. An anchored decision produces a receipt, recorded beside the decision's
 *      own audit evidence, naming the decision CID that was anchored.
 *   2. Anchoring — succeeding, absent, throwing, or hanging — leaves the
 *      governance outcome *structurally identical* in all four states. This is
 *      proved by comparing the resulting proposal and decision records field by
 *      field, not by asserting a status code.
 *   3. Anchoring is turned off by proposal and quorum, like any other change to
 *      the protected settings record. There is no admin override left: the
 *      direct call is refused with `requiresProposal`.
 *
 * Everything runs on real signed records through the real endpoints; the only
 * fake is the attestor itself, which is the seam the whole design exists to
 * keep replaceable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { enforceGovernance } from '../../src/governance/enforcement.js';
import { applyIfDue, applyProposedChange } from '../../src/governance/timelock.js';
import { registerAttestor, clearAttestors, type GovernanceAttestor } from '../../src/governance/attestor.js';
import { anchoringConfig } from '../../src/governance/anchoring.js';

const CHAIN_ID = 'eip155:31337';
const SETTINGS_COLLECTION = 'net.openfederation.community.settings';
const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const DECISION_COLLECTION = 'net.openfederation.governance.decision';
const TARGET_COLLECTION = 'app.example.anchored';

type User = { accessJwt: string; did: string; handle: string };

/** Anchor calls this suite made, so "was it consulted at all?" is answerable. */
let anchored: string[] = [];

function attestor(anchor: (cid: string) => Promise<any>): GovernanceAttestor {
  return {
    chainId: CHAIN_ID,
    name: 'test-notary',
    verifyProof: async () => ({ verified: true }),
    anchor: async (cid: string) => {
      anchored.push(cid);
      return anchor(cid);
    },
  };
}

const receiptAttestor = () => attestor(async (cid) => ({
  chainId: CHAIN_ID,
  anchoredCid: cid,
  transactionHash: '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
  timestamp: 1_700_000_000,
}));

const throwingAttestor = () => attestor(async () => { throw new Error('notary is down'); });

const hangingAttestor = () => attestor(() => new Promise(() => {}));

async function proposalRecord(communityDid: string, rkey: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, rkey],
  );
  return res.rows[0]?.record;
}

async function decisionRecord(communityDid: string, rkey: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, DECISION_COLLECTION, rkey],
  );
  return res.rows[0]?.record;
}

async function communitySettings(communityDid: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = 'self'`,
    [communityDid, SETTINGS_COLLECTION],
  );
  return res.rows[0]?.record;
}

async function auditMetas(action: string, communityDid: string, rkey?: string) {
  const res = await query<{ meta: any }>(
    `SELECT meta FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id ASC`,
    [action, communityDid],
  );
  return res.rows
    .map(r => r.meta)
    .filter(m => rkey === undefined || m?.rkey === rkey);
}

/**
 * Everything about a resolution that must not depend on a notary, with the
 * parts that legitimately differ between two proposals (identifiers, hashes,
 * timestamps) replaced by a marker. What survives is the shape of the outcome:
 * status, tally, outcome, evidence completeness, who was counted, and what the
 * decision says about the change it authorizes.
 */
const VARIABLE_KEYS = new Set([
  'uri', 'cid', 'rkey', 'proposalRkey', 'targetRkey', 'proposalCid',
  'createdAt', 'expiresAt', 'resolvedAt', 'appliedAt', 'applyAt', 'cidChain',
]);

function normalize(value: any): any {
  if (Array.isArray(value)) {
    // Sequence-sensitive on purpose. `votes` used to arrive in whatever order
    // the database returned, so this compared sets; since #204 the tally sorts
    // by the same earliest-record key the one-vote-per-voter rule uses, so the
    // order is part of what anchoring must leave untouched.
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = VARIABLE_KEYS.has(key) ? '<varies>' : normalize(value[key]);
    }
    return out;
  }
  return value;
}

describe('Governance anchoring (#198)', () => {
  let plcAvailable: boolean;
  let owner: User;
  let voter1: User;
  let voter2: User;
  let communityDid: string;

  const QUORUM = 3;

  /** Normalized outcome shapes, compared across every anchoring state. */
  const shapes: Record<string, any> = {};

  async function createProposal(targetRkey: string, body?: Record<string, unknown>) {
    const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: TARGET_COLLECTION,
      targetRkey,
      action: 'write',
      proposedRecord: { value: 'constant' },
      ...body,
    });
    expect(res.status).toBe(200);
    return res.body as { uri: string; cid: string; rkey: string };
  }

  /** Owner's seed vote plus two more reaches the quorum of 3 and resolves. */
  async function passProposal(targetRkey: string, body?: Record<string, unknown>) {
    const created = await createProposal(targetRkey, body);
    let last: any;
    for (const voter of [voter1, voter2]) {
      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid, proposalRkey: created.rkey, vote: 'for',
      });
      expect(res.status).toBe(200);
      last = res.body;
    }
    return { ...created, resolution: last };
  }

  /** The resolution as it stands in the repo, with everything variable removed. */
  async function outcomeShape(rkey: string) {
    const proposal = await proposalRecord(communityDid, rkey);
    const decision = await decisionRecord(communityDid, proposal.decision.rkey);
    return { proposal: normalize(proposal), decision: normalize(decision) };
  }

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    // A hanging notary must not hang a resolution. The bound is exercised for
    // real, just at a length a test suite can afford.
    process.env.GOVERNANCE_ANCHOR_TIMEOUT_MS = '250';

    owner = await createTestUser(uniqueHandle('anch-owner'));
    voter1 = await createTestUser(uniqueHandle('anch-voter1'));
    voter2 = await createTestUser(uniqueHandle('anch-voter2'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('anch-comm'),
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

    // Anchoring is switched on here, while the community is still under
    // benevolent-dictator rule — the last moment at which any single account
    // can decide anything about this community on its own.
    const modelRes = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: {
        quorum: QUORUM,
        voterRole: 'moderator',
        proposalTtlDays: 7,
        timelockHours: 0,
        anchoring: { enabled: true, chainId: CHAIN_ID },
      },
    });
    expect(modelRes.status).toBe(200);
  });

  afterAll(() => {
    clearAttestors();
    delete process.env.GOVERNANCE_ANCHOR_TIMEOUT_MS;
  });

  describe('what the settings record says about anchoring', () => {
    it('reads an explicit block, and treats on-chain as anchoring by default', () => {
      expect(anchoringConfig({ governanceConfig: { anchoring: { enabled: true, chainId: CHAIN_ID } } }))
        .toEqual({ enabled: true, chainId: CHAIN_ID });
      // on-chain is anchoring plus core governance; the chain id it already
      // carries is the notary.
      expect(anchoringConfig({ governanceModel: 'on-chain', governanceConfig: { chainId: CHAIN_ID } }))
        .toEqual({ enabled: true, chainId: CHAIN_ID });
      // An explicit block always wins, including over the model default.
      expect(anchoringConfig({ governanceModel: 'on-chain', governanceConfig: { chainId: CHAIN_ID, anchoring: { enabled: false } } }))
        .toEqual({ enabled: false, chainId: null });
      // Every other model anchors only if it says so.
      expect(anchoringConfig({ governanceModel: 'simple-majority', governanceConfig: { quorum: 3 } }))
        .toEqual({ enabled: false, chainId: null });
      expect(anchoringConfig(undefined)).toEqual({ enabled: false, chainId: null });
    });
  });

  describe('an anchored decision carries a receipt', () => {
    let rkey: string;
    let decisionRef: { uri: string; cid: string; rkey: string };

    it('resolves normally and hands the decision CID to the attestor', async () => {
      if (!plcAvailable) return;
      anchored = [];
      clearAttestors();
      registerAttestor(receiptAttestor());

      const passed = await passProposal('anchored-1');
      rkey = passed.rkey;
      expect(passed.resolution.status).toBe('approved');
      expect(passed.resolution.applied).toBe(true);

      const proposal = await proposalRecord(communityDid, rkey);
      decisionRef = proposal.decision;
      expect(decisionRef.cid).toBeTruthy();
      // What is notarized is the decision itself, not a summary of it.
      expect(anchored).toEqual([decisionRef.cid]);

      // Kept for the isolation comparison below: a *successful* anchor has to be
      // one of the states proved identical, or all that is proved is that three
      // kinds of failure resemble each other.
      shapes.anchored = await outcomeShape(rkey);
      shapes.anchoredResolution = passed.resolution;
    });

    it('records the receipt beside the decision evidence in the audit trail', async () => {
      if (!plcAvailable) return;
      const [meta] = await auditMetas('community.proposal.decision.anchored', communityDid, rkey);
      expect(meta).toBeTruthy();
      expect(meta.decisionUri).toBe(decisionRef.uri);
      expect(meta.decisionCid).toBe(decisionRef.cid);
      expect(meta.anchoredCid).toBe(decisionRef.cid);
      expect(meta.chainId).toBe(CHAIN_ID);
      expect(meta.transactionHash).toBe('0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface');
      expect(meta.timestamp).toBe(1_700_000_000);
      expect(await auditMetas('community.proposal.decision.anchorFailed', communityDid, rkey)).toEqual([]);
    });

    it('leaves the signed decision record untouched — the receipt is about it, not in it', async () => {
      if (!plcAvailable) return;
      const fetched = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: DECISION_COLLECTION, rkey: decisionRef.rkey,
      });
      expect(fetched.status).toBe(200);
      // Writing the receipt into the record would change the very CID the
      // receipt attests to. It still hashes to what was anchored.
      expect(fetched.body.cid).toBe(decisionRef.cid);
      expect(fetched.body.value.anchor).toBeUndefined();
      expect(fetched.body.value.outcome).toBe('approved');
    });
  });

  describe('a failing notary cannot change what governance decided', () => {
    it('resolves identically with no attestor registered at all (the control)', async () => {
      if (!plcAvailable) return;
      anchored = [];
      clearAttestors();

      const passed = await passProposal('isolation-control');
      expect(passed.resolution.status).toBe('approved');
      expect(passed.resolution.applied).toBe(true);
      shapes.control = await outcomeShape(passed.rkey);
      shapes.controlResolution = passed.resolution;

      expect((await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'isolation-control',
      })).status).toBe(200);

      // An unregistered attestor is a deployment fact, not a failed notary: it
      // is reported once to the log and never audited or queued.
      expect(await auditMetas('community.proposal.decision.anchorFailed', communityDid, passed.rkey)).toEqual([]);
      expect(await auditMetas('community.proposal.decision.anchored', communityDid, passed.rkey)).toEqual([]);
    });

    it('resolves identically when the attestor throws', async () => {
      if (!plcAvailable) return;
      anchored = [];
      clearAttestors();
      registerAttestor(throwingAttestor());

      const passed = await passProposal('isolation-throw');
      expect(passed.resolution).toEqual(shapes.controlResolution);
      shapes.threw = await outcomeShape(passed.rkey);

      expect(anchored.length).toBeGreaterThan(0);
      expect((await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'isolation-throw',
      })).status).toBe(200);

      const [meta] = await auditMetas('community.proposal.decision.anchorFailed', communityDid, passed.rkey);
      expect(meta.reason).toContain('notary is down');
      expect(await auditMetas('community.proposal.decision.anchored', communityDid, passed.rkey)).toEqual([]);
    });

    it('resolves identically when the attestor never answers', async () => {
      if (!plcAvailable) return;
      anchored = [];
      clearAttestors();
      registerAttestor(hangingAttestor());

      const started = Date.now();
      const passed = await passProposal('isolation-hang');
      const elapsed = Date.now() - started;
      expect(passed.resolution).toEqual(shapes.controlResolution);
      shapes.hung = await outcomeShape(passed.rkey);

      // Bounded, not blocked, and bounded by the configured 250ms rather than by
      // luck: the default bound is 5s, so an override that never took effect —
      // or a timeout that applied to neither vote — could not finish this fast.
      expect(elapsed).toBeLessThan(3_000);
      expect((await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'isolation-hang',
      })).status).toBe(200);

      const [meta] = await auditMetas('community.proposal.decision.anchorFailed', communityDid, passed.rkey);
      expect(meta.reason).toContain('did not respond');
    });

    it('produced structurally identical proposals and decisions in all three cases', async () => {
      if (!plcAvailable) return;
      expect(shapes.threw).toEqual(shapes.control);
      expect(shapes.hung).toEqual(shapes.control);
      // …and the state that actually worked, so the claim is "anchoring changes
      // nothing" rather than "failing changes nothing".
      expect(shapes.anchored).toEqual(shapes.control);
      expect(shapes.anchoredResolution).toEqual(shapes.controlResolution);
      // The comparison is only meaningful if the shape has real content in it.
      expect(shapes.control.decision.outcome).toBe('approved');
      expect(shapes.control.decision.tally).toEqual({ votesFor: QUORUM, votesAgainst: 0, total: QUORUM });
      expect(shapes.control.decision.evidenceComplete).toBe(true);
      expect(shapes.control.proposal.status).toBe('approved');
    });

    it('retries a failed anchor on the next resolution, and stops once it lands', async () => {
      if (!plcAvailable) return;
      // The failures above are the queue. A working notary drains them without
      // anyone asking it to.
      anchored = [];
      clearAttestors();
      registerAttestor(receiptAttestor());

      const failedBefore = await auditMetas('community.proposal.decision.anchorFailed', communityDid);
      const pending = new Set(failedBefore.map(m => m.decisionCid));
      // The throwing and hanging runs; the unregistered one queued nothing.
      expect(pending.size).toBe(2);

      const passed = await passProposal('retry-drain');
      // Its own decision, plus the ones it retried.
      expect(anchored.length).toBeGreaterThan(1);

      const succeeded = new Set(
        (await auditMetas('community.proposal.decision.anchored', communityDid)).map(m => m.decisionCid),
      );
      for (const cid of pending) expect(succeeded.has(cid)).toBe(true);

      // Nothing is anchored twice: the next resolution has an empty queue.
      anchored = [];
      await passProposal('retry-settled');
      expect(anchored.length).toBe(1);
    });
  });

  describe('anchoring is turned off by proposal, not by an operator', () => {
    it('refuses a direct settings change — there is no override left', async () => {
      if (!plcAvailable) return;
      const settings = await communitySettings(communityDid);
      const direct = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid,
        governanceModel: 'simple-majority',
        governanceConfig: { ...settings.governanceConfig, anchoring: { enabled: false } },
      });
      expect(direct.status).toBe(403);
      expect(direct.body.error).toBe('GovernanceDenied');
      expect(direct.body.requiresProposal).toBe(true);

      // Nor by writing the settings record directly: the raw repo path refuses
      // the settings collection outright (it has a dedicated endpoint), so the
      // governed endpoint above is the only way in, and it now says no.
      const raw = await xrpcAuthPost('com.atproto.repo.putRecord', owner.accessJwt, {
        repo: communityDid, collection: SETTINGS_COLLECTION, rkey: 'self',
        record: { ...settings, governanceConfig: { ...settings.governanceConfig, anchoring: { enabled: false } } },
      });
      expect(raw.status).toBe(400);
      expect(raw.body.error).toBe('UseDedicatedEndpoint');

      expect((await communitySettings(communityDid)).governanceConfig.anchoring.enabled).toBe(true);
    });

    it('turns anchoring off through the ordinary proposal flow', async () => {
      if (!plcAvailable) return;
      anchored = [];
      clearAttestors();
      registerAttestor(receiptAttestor());

      const settings = await communitySettings(communityDid);
      const passed = await passProposal('unused-target', {
        targetCollection: SETTINGS_COLLECTION,
        targetRkey: 'self',
        proposedRecord: {
          ...settings,
          governanceConfig: { ...settings.governanceConfig, anchoring: { enabled: false, chainId: CHAIN_ID } },
        },
      });
      expect(passed.resolution.status).toBe('approved');
      expect(passed.resolution.applied).toBe(true);

      const updated = await communitySettings(communityDid);
      expect(updated.governanceConfig.anchoring).toEqual({ enabled: false, chainId: CHAIN_ID });
      // Quorum and voting are untouched — only the notary went away.
      expect(updated.governanceConfig.quorum).toBe(QUORUM);
      expect(updated.governanceModel).toBe('simple-majority');
    });

    it('stops anchoring once the community has said so', async () => {
      if (!plcAvailable) return;
      anchored = [];
      const passed = await passProposal('after-disable');
      expect(passed.resolution.applied).toBe(true);
      expect(anchored).toEqual([]);
      expect(await auditMetas('community.proposal.decision.anchored', communityDid, passed.rkey)).toEqual([]);
      expect(await auditMetas('community.proposal.decision.anchorFailed', communityDid, passed.rkey)).toEqual([]);
    });
  });

  describe('on-chain is that same governance, with the notary switched back on', () => {
    it('adopts on-chain by proposal and keeps deciding from vote records', async () => {
      if (!plcAvailable) return;
      anchored = [];
      const settings = await communitySettings(communityDid);
      const { governanceConfig } = settings;
      delete governanceConfig.anchoring;

      const adopted = await passProposal('unused-target-2', {
        targetCollection: SETTINGS_COLLECTION,
        targetRkey: 'self',
        proposedRecord: {
          ...settings,
          governanceModel: 'on-chain',
          governanceConfig: { ...governanceConfig, chainId: CHAIN_ID },
        },
      });
      expect(adopted.resolution.applied).toBe(true);
      expect((await communitySettings(communityDid)).governanceModel).toBe('on-chain');

      // An on-chain community proposes and votes exactly like any other, and
      // anchors by default because that is now all the model means.
      anchored = [];
      const passed = await passProposal('on-chain-1');
      expect(passed.resolution.status).toBe('approved');
      expect(passed.resolution.applied).toBe(true);

      const proposal = await proposalRecord(communityDid, passed.rkey);
      const decision = await decisionRecord(communityDid, proposal.decision.rkey);
      expect(decision.outcome).toBe('approved');
      expect(decision.votes).toHaveLength(QUORUM);
      expect(anchored).toEqual([proposal.decision.cid]);

      const [meta] = await auditMetas('community.proposal.decision.anchored', communityDid, passed.rkey);
      expect(meta.anchoredCid).toBe(proposal.decision.cid);
    });
  });

  describe('what may change a community\'s governance, and what may not', () => {
    // By this point the community is on-chain, which is the model with a
    // delegated-authority branch in enforceGovernance.
    const delegated = (did: string) => ({
      source: 'test-authority',
      communityDid: did,
      credentialId: 'cred-1',
      name: 'Delegated service',
    });

    it('lets a delegated service act under the community governance', async () => {
      if (!plcAvailable) return;
      const result = await enforceGovernance(
        communityDid, 'net.openfederation.community.profile', 'write', delegated(communityDid),
      );
      expect(result.allowed).toBe(true);
    });

    it('does not let a delegated service change what that governance is', async () => {
      if (!plcAvailable) return;
      // The ratchet is gone; it must not have been replaced by a service-shaped
      // escape hatch. A credential that could rewrite `governanceModel` to
      // benevolent-dictator would make every protected collection directly
      // writable a moment later.
      const result = await enforceGovernance(
        communityDid, SETTINGS_COLLECTION, 'write', delegated(communityDid),
      );
      expect(result.allowed).toBe(false);
      expect(result.requiresProposal).toBe(true);
      expect(result.reason).toContain('proposal');
    });

    it('refuses a settings proposal naming a model nothing recognizes', async () => {
      if (!plcAvailable) return;
      const settings = await communitySettings(communityDid);
      const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid,
        targetCollection: SETTINGS_COLLECTION,
        targetRkey: 'self',
        action: 'write',
        proposedRecord: { ...settings, governanceModel: 'simple_majority' },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('governanceModel must be one of');
    });

    it('refuses to apply such a record even if a proposal carrying it exists', async () => {
      if (!plcAvailable) return;
      const settings = await communitySettings(communityDid);
      const engine = new RepoEngine(communityDid);
      const keypair = await getKeypairForDid(communityDid);
      await expect(applyProposedChange(engine, keypair, {
        action: 'write',
        targetCollection: SETTINGS_COLLECTION,
        targetRkey: 'self',
        proposedRecord: { ...settings, governanceModel: 'plutocracy' },
      })).rejects.toThrow(/ungoverned/);
      // Nothing was written: the community still has the model it voted for.
      expect((await communitySettings(communityDid)).governanceModel).toBe('on-chain');
    });

    it('rejects an on-chain config whose chainId is empty rather than silently not anchoring', async () => {
      if (!plcAvailable) return;
      // Validation runs before enforcement, so this is a 400 about the config
      // rather than a 403 about the route. An empty chainId would resolve to
      // anchoring disabled: an on-chain community that never anchors.
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid,
        governanceModel: 'on-chain',
        governanceConfig: { quorum: QUORUM, voterRole: 'moderator', chainId: '' },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('chainId is required');

      const settings = await communitySettings(communityDid);
      const proposed = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid,
        targetCollection: SETTINGS_COLLECTION,
        targetRkey: 'self',
        action: 'write',
        proposedRecord: { ...settings, governanceConfig: { ...settings.governanceConfig, chainId: '  ' } },
      });
      expect(proposed.status).toBe(400);
      expect(proposed.body.message).toContain('chainId is required');
    });

    it('never claims appliedAt for a timelocked change it refused to make', async () => {
      if (!plcAvailable) return;
      // A pending proposal carrying a settings record that cannot be applied.
      // Written directly, because every endpoint now refuses to create one —
      // which is the point: this is the backstop path.
      const settings = await communitySettings(communityDid);
      const engine = new RepoEngine(communityDid);
      const keypair = await getKeypairForDid(communityDid);
      const rkey = RepoEngine.generateTid();
      await engine.putRecord(keypair, PROPOSAL_COLLECTION, rkey, {
        targetCollection: SETTINGS_COLLECTION,
        targetRkey: 'self',
        action: 'write',
        proposedRecord: { ...settings, governanceModel: 'plutocracy' },
        proposedBy: owner.did,
        status: 'pending-application',
        votesFor: [owner.did],
        votesAgainst: [],
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        resolvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        applyAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });

      const outcome = await applyIfDue({ communityDid, proposalRkey: rkey });
      expect(outcome.state).toBe('unapplicable');

      // Closed, so the change stays single-shot — but asserting nothing that
      // did not happen.
      const proposal = await proposalRecord(communityDid, rkey);
      expect(proposal.status).toBe('approved');
      expect(proposal.appliedAt).toBeUndefined();
      const [meta] = await auditMetas('community.proposal.applyFailed', communityDid, rkey);
      expect(meta.reason).toContain('ungoverned');
      // And the community still has the governance it actually voted for.
      expect((await communitySettings(communityDid)).governanceModel).toBe('on-chain');
    });

    it('denies protected writes outright when the settings record already names an unknown model', async () => {
      if (!plcAvailable) return;
      // Simulates a record that predates the validation above (or a downgrade to
      // an older PDS). Written through the community's own key, deliberately
      // bypassing every endpoint, because that is the only way such a record
      // could exist.
      const settings = await communitySettings(communityDid);
      const engine = new RepoEngine(communityDid);
      const keypair = await getKeypairForDid(communityDid);
      await engine.putRecord(keypair, SETTINGS_COLLECTION, 'self', { ...settings, governanceModel: 'plutocracy' });
      try {
        const result = await enforceGovernance(communityDid, SETTINGS_COLLECTION, 'write', null);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('unrecognized governance model');
        // Not just the settings record — nothing protected falls open.
        const profile = await enforceGovernance(communityDid, 'net.openfederation.community.profile', 'write', null);
        expect(profile.allowed).toBe(false);
      } finally {
        await engine.putRecord(keypair, SETTINGS_COLLECTION, 'self', settings);
      }
    });
  });
});
