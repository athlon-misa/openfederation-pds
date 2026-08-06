/**
 * Shared fixture for the offline-verification tests.
 *
 * Builds the artefacts `voteOnProposal` actually writes — a proposal rewritten
 * after every vote, voter-signed vote records in the voters' own repos, a
 * decision in the community repo, then the status rewrite — using real
 * secp256k1 keypairs and real MST commits from `@atproto/repo`. Nothing is
 * stubbed: a "valid" verdict has to be earned by a signature that verifies.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 */
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  MemoryBlockstore,
  Repo,
  WriteOpAction,
  cidForRecord,
  getFullRepo,
} from '@atproto/repo';
import {
  DECISION_COLLECTION,
  PROPOSAL_COLLECTION,
  SETTINGS_COLLECTION,
  VOTE_COLLECTION,
  quorumRule,
} from '../../../src/governance/decision-rules.js';
import type {
  CitedRecord,
  DidDocumentLike,
  RepoProof,
  VerifyDecisionInput,
} from '../../../src/governance/verify-decision.js';

export class TestRepo {
  private constructor(
    readonly did: string,
    readonly keypair: Secp256k1Keypair,
    readonly storage: MemoryBlockstore,
    private repo: Repo,
  ) {}

  static async create(did: string): Promise<TestRepo> {
    const keypair = await Secp256k1Keypair.create({ exportable: true });
    const storage = new MemoryBlockstore();
    const repo = await Repo.create(storage, did, keypair);
    return new TestRepo(did, keypair, storage, repo);
  }

  /** Write a record and return its CID, exactly as the PDS would. */
  async put(collection: string, rkey: string, record: Record<string, unknown>): Promise<string> {
    const existing = await this.repo.data.get(`${collection}/${rkey}`);
    this.repo = await this.repo.applyWrites(
      {
        action: existing ? WriteOpAction.Update : WriteOpAction.Create,
        collection,
        rkey,
        record,
      },
      this.keypair,
    );
    return (await cidForRecord(record)).toString();
  }

  proof(): RepoProof {
    return { did: this.did, commit: this.repo.cid.toString(), blocks: this.storage.blocks };
  }

  /** A DID document carrying this repo's atproto signing key. */
  didDoc(keypair: Secp256k1Keypair = this.keypair): DidDocumentLike {
    return {
      id: this.did,
      verificationMethod: [
        {
          id: `${this.did}#atproto`,
          type: 'Multikey',
          controller: this.did,
          publicKeyMultibase: keypair.did().slice('did:key:'.length),
        },
      ],
    };
  }

  async car(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of getFullRepo(this.storage, this.repo.cid)) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

export const PROPOSAL_RKEY = '3laaaaproposal';
export const DECISION_RKEY = '3laaaadecision1';
export const CREATED_AT = '2026-01-01T00:00:00.000Z';

export interface Voter { name: string; repo: TestRepo; choice: 'for' | 'against'; rkey: string; castAt: string }

export interface Scenario {
  community: TestRepo;
  voters: Voter[];
  /** Voters whose repo/vote exists but who the decision must not cite. */
  extraVoters: Voter[];
  proposal: CitedRecord;
  decision: CitedRecord;
  proposalUri: string;
  input(): VerifyDecisionInput;
}

export interface ScenarioOpts {
  choices?: Array<'for' | 'against'>;
  /** Threshold published on the decision record. */
  quorum?: number;
  /**
   * Threshold in the community's settings record. Defaults to whatever the
   * decision publishes, i.e. an honest PDS. Set it apart from `quorum` to model
   * a decision that claims a rule its community does not have.
   */
  settingsQuorum?: number;
  /** Omit the settings record entirely, so the community's rule is unknowable. */
  omitSettings?: boolean;
  /** Voters who vote and record but are deliberately left out of the decision. */
  uncited?: Array<'for' | 'against'>;
  /** Cached votes with no record at all, disclosed as uncountedVotes. */
  cacheOnly?: string[];
  /** Make one cited vote point at a proposal CID outside the lineage. */
  breakLineageFor?: number;
  outcome?: 'approved' | 'rejected';
  /** Applied to the decision record before it is written. */
  mutateDecision?: (decision: Record<string, any>) => void;
  /** Close the proposal as expired instead of resolved (orphan decision). */
  expireProposal?: boolean;
  /**
   * Membership evidence on each vote (#200).
   *
   *   undefined  no evidence at all — a vote written before #200 existed
   *   'role'     member records assigning a role record that grants
   *              community.governance.write
   *   'legacy'   member records naming a built-in role, no role record
   *   'no-perm'  a role record that does *not* grant governance.write
   */
  eligibility?: 'role' | 'legacy' | 'no-perm';
  /** Applied to each vote's eligibility block before the record is written. */
  mutateEligibility?: (e: Record<string, any>, index: number) => void;
}

export async function buildScenario(opts: ScenarioOpts = {}): Promise<Scenario> {
  const choices = opts.choices ?? ['for', 'for', 'for'];
  const community = await TestRepo.create('did:plc:communityaaaaaaaaaaaa');
  const proposalUri = `at://${community.did}/${PROPOSAL_COLLECTION}/${PROPOSAL_RKEY}`;

  const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
  let nameAt = 0;
  const makeVoter = async (choice: 'for' | 'against', index: number): Promise<Voter> => {
    const name = names[nameAt++];
    return {
      name,
      repo: await TestRepo.create(`did:plc:voter${name}aaaaaaaaaaaa`),
      choice,
      rkey: `3lvote${name}`,
      castAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    };
  };

  const voters: Voter[] = [];
  for (let i = 0; i < choices.length; i++) voters.push(await makeVoter(choices[i], i));
  const extraVoters: Voter[] = [];
  for (let i = 0; i < (opts.uncited ?? []).length; i++) {
    extraVoters.push(await makeVoter(opts.uncited![i], choices.length + i));
  }

  // The community's settings record — where the quorum rule actually lives, and
  // what the verifier checks the decision's self-declared threshold against.
  const publishedQuorum = opts.quorum ?? 3;
  if (!opts.omitSettings) {
    await community.put(SETTINGS_COLLECTION, 'self', {
      $type: SETTINGS_COLLECTION,
      displayName: 'Test Community',
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: opts.settingsQuorum ?? publishedQuorum, voterRole: 'moderator' },
      createdAt: CREATED_AT,
    });
  }

  // Proposal v1 — open, no votes yet.
  const proposalValue: Record<string, any> = {
    $type: PROPOSAL_COLLECTION,
    evidenceModel: 'vote-records',
    status: 'open',
    createdAt: CREATED_AT,
    targetCollection: 'net.openfederation.community.settings',
    targetRkey: 'self',
    action: 'write',
    proposedRecord: { $type: 'net.openfederation.community.settings', displayName: 'Renamed' },
    votesFor: [],
    votesAgainst: [],
    cidChain: [],
  };
  let proposalCid = await community.put(PROPOSAL_COLLECTION, PROPOSAL_RKEY, proposalValue);

  // Membership evidence (#200): the community-signed records a vote cites to
  // show its caster was entitled to vote.
  const MEMBER_COLLECTION = 'net.openfederation.community.member';
  const ROLE_COLLECTION = 'net.openfederation.community.role';
  const eligibilityFor = new Map<string, Record<string, any>>();
  if (opts.eligibility) {
    const roleRkey = '3lrolemoderator';
    let roleCid: string | null = null;
    if (opts.eligibility !== 'legacy') {
      roleCid = await community.put(ROLE_COLLECTION, roleRkey, {
        $type: ROLE_COLLECTION,
        name: 'moderator',
        permissions: opts.eligibility === 'no-perm'
          ? ['community.member.read']
          : ['community.member.read', 'community.governance.write'],
        createdAt: CREATED_AT,
      });
    }
    for (const voter of [...voters, ...extraVoters]) {
      const memberRkey = `3lmember${voter.name}`;
      const memberValue: Record<string, any> = {
        $type: MEMBER_COLLECTION,
        did: voter.repo.did,
        role: opts.eligibility === 'legacy' ? 'moderator' : 'member',
        createdAt: CREATED_AT,
      };
      if (opts.eligibility !== 'legacy') memberValue.roleRkey = roleRkey;
      const memberCid = await community.put(MEMBER_COLLECTION, memberRkey, memberValue);
      eligibilityFor.set(voter.repo.did, {
        member: { uri: `at://${community.did}/${MEMBER_COLLECTION}/${memberRkey}`, cid: memberCid },
        roleRecord: roleCid
          ? { uri: `at://${community.did}/${ROLE_COLLECTION}/${roleRkey}`, cid: roleCid }
          : null,
        roleName: 'moderator',
        grantedGovernanceWrite: opts.eligibility !== 'no-perm',
      });
    }
  }

  // Each vote: the voter signs a record citing the proposal state they saw,
  // then the proposal is rewritten with the vote cache and the CID lineage.
  const cited: Array<Record<string, unknown>> = [];
  const all = [...voters, ...extraVoters];
  for (let i = 0; i < all.length; i++) {
    const voter = all[i];
    const seenCid = i === opts.breakLineageFor
      ? (await cidForRecord({ $type: 'net.openfederation.decoy', n: i })).toString()
      : proposalCid;
    const voteValue = {
      $type: VOTE_COLLECTION,
      community: community.did,
      proposal: { uri: proposalUri, cid: seenCid },
      proposalCollection: PROPOSAL_COLLECTION,
      proposalRkey: PROPOSAL_RKEY,
      vote: voter.choice,
      createdAt: voter.castAt,
    } as Record<string, any>;
    const ev = eligibilityFor.get(voter.repo.did);
    if (ev) {
      const copy = JSON.parse(JSON.stringify(ev));
      opts.mutateEligibility?.(copy, i);
      voteValue.eligibility = copy;
    }
    const voteCid = await voter.repo.put(VOTE_COLLECTION, voter.rkey, voteValue);
    if (voters.includes(voter)) {
      cited.push({
        voter: voter.repo.did,
        vote: voter.choice,
        record: { uri: `at://${voter.repo.did}/${VOTE_COLLECTION}/${voter.rkey}`, cid: voteCid },
        proposalCid: seenCid,
      });
    }

    const arr = voter.choice === 'for' ? 'votesFor' : 'votesAgainst';
    proposalValue[arr] = [...proposalValue[arr], voter.repo.did];
    proposalValue.cidChain = [...proposalValue.cidChain, proposalCid];
    proposalCid = await community.put(PROPOSAL_COLLECTION, PROPOSAL_RKEY, proposalValue);
  }

  for (const did of opts.cacheOnly ?? []) {
    proposalValue.votesFor = [...proposalValue.votesFor, did];
    proposalValue.cidChain = [...proposalValue.cidChain, proposalCid];
    proposalCid = await community.put(PROPOSAL_COLLECTION, PROPOSAL_RKEY, proposalValue);
  }

  // The decision is written against the proposal as it stood at resolution.
  const resolvedAgainstCid = proposalCid;
  const countedFor = cited.filter(v => v.vote === 'for').length;
  const countedAgainst = cited.length - countedFor;
  const uncountedVotes = (opts.cacheOnly ?? []).map(did => ({ voter: did, vote: 'for', reason: 'no-vote-record' }));

  const decisionValue: Record<string, any> = {
    $type: DECISION_COLLECTION,
    community: community.did,
    proposal: { uri: proposalUri, cid: resolvedAgainstCid },
    proposalCollection: PROPOSAL_COLLECTION,
    proposalRkey: PROPOSAL_RKEY,
    outcome: opts.outcome ?? (countedFor > countedAgainst ? 'approved' : 'rejected'),
    quorum: quorumRule('simple-majority', publishedQuorum),
    tally: { votesFor: countedFor, votesAgainst: countedAgainst, total: cited.length },
    votes: cited,
    ...(uncountedVotes.length > 0 ? { uncountedVotes } : {}),
    evidenceComplete: uncountedVotes.length === 0,
    action: { targetCollection: 'net.openfederation.community.settings', targetRkey: 'self', action: 'write' },
    resolvedAt: '2026-01-01T01:00:00.000Z',
  };
  opts.mutateDecision?.(decisionValue);
  const decisionCid = await community.put(DECISION_COLLECTION, DECISION_RKEY, decisionValue);

  // Status rewrite: closes the proposal and pushes the resolved-against state
  // into the lineage, which is what keeps the decision's citation checkable.
  proposalValue.status = opts.expireProposal ? 'expired' : decisionValue.outcome;
  proposalValue.resolvedAt = '2026-01-01T01:00:01.000Z';
  proposalValue.decision = {
    uri: `at://${community.did}/${DECISION_COLLECTION}/${DECISION_RKEY}`,
    cid: decisionCid,
    rkey: DECISION_RKEY,
  };
  proposalValue.cidChain = [...proposalValue.cidChain, proposalCid];
  proposalCid = await community.put(PROPOSAL_COLLECTION, PROPOSAL_RKEY, { ...proposalValue });

  const scenario: Scenario = {
    community,
    voters,
    extraVoters,
    proposalUri,
    proposal: { uri: proposalUri, cid: proposalCid, value: { ...proposalValue } },
    decision: {
      uri: `at://${community.did}/${DECISION_COLLECTION}/${DECISION_RKEY}`,
      cid: decisionCid,
      value: decisionValue,
    },
    input() {
      const repos = [community, ...voters.map(v => v.repo), ...extraVoters.map(v => v.repo)];
      return {
        decision: scenario.decision,
        proposal: scenario.proposal,
        repos: repos.map(r => r.proof()),
        didDocuments: repos.map(r => r.didDoc()),
        siblingDecisions: [],
      };
    },
  };
  return scenario;
}

