/**
 * Fixture for the offline application-legitimacy tests (#201).
 *
 * Builds on the decision fixture rather than beside it: an application scenario
 * *is* a decided proposal plus the timelock rewrite, and duplicating the vote
 * machinery would let the two drift into disagreeing about what a resolved
 * proposal looks like.
 *
 * What it reproduces is what the PDS actually writes — `voteOnProposal` moving
 * an approved proposal to `pending-application` with an `applyAt`, objectors
 * signing records in their own repos, and `applyIfDue` rewriting the proposal as
 * applied or held. Real keypairs, real MST commits; a legitimate verdict has to
 * be earned.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 */
import {
  OBJECTION_COLLECTION,
  PROPOSAL_COLLECTION,
  SETTINGS_COLLECTION,
  applyAtFrom,
} from '../../../src/governance/decision-rules.js';
import type {
  CitedRecord,
  DidDocumentLike,
  RepoProof,
} from '../../../src/governance/verify-decision.js';
import type { VerifyApplicationInput } from '../../../src/governance/verify-application.js';
import { PROPOSAL_RKEY, TestRepo, buildScenario } from './governance-decision-fixture.js';

/** One objector, and how honest their record is. */
export interface ObjectionSpec {
  name: string;
  /** Offset from `resolvedAt`, in hours. Inside the window unless stated. */
  atHours?: number;
  /** Cite a decision CID that is not the one being applied. */
  wrongDecision?: boolean;
  /** Name the objector on the proposal's cache but write no record at all. */
  cacheOnly?: boolean;
  /** Cache and write the record, but leave the repo out of the exports. */
  withholdRepo?: boolean;
}

export interface ApplicationOpts {
  /** What the proposal's own `status` says. */
  state: 'pending-application' | 'applied' | 'objected' | 'rejected';
  /** Contest window in the community's settings record. Default 24. */
  timelockHours?: number;
  /** Objection threshold in the community's settings record. Default 1. */
  objectionThreshold?: number;
  /** Drop the settings record, so the threshold is unknowable. */
  omitSettings?: boolean;
  /**
   * `appliedAt` for the applied state. Defaults to one minute after `applyAt`;
   * `null` writes no `appliedAt` at all, which is what the PDS records when a
   * passed change is refused as unapplicable.
   */
  appliedAt?: string | null;
  /** Applied state with no `applyAt` at all — the `timelockHours: 0` path. */
  noWindow?: boolean;
  objections?: ObjectionSpec[];
}

export interface ApplicationScenario {
  community: TestRepo;
  objectors: Map<string, TestRepo>;
  proposal: CitedRecord;
  resolvedAt: string;
  applyAt: string | null;
  input(overrides?: Partial<VerifyApplicationInput>): VerifyApplicationInput;
}

export async function buildApplicationScenario(opts: ApplicationOpts): Promise<ApplicationScenario> {
  const base = await buildScenario({ omitSettings: opts.omitSettings });
  const community = base.community;
  const resolvedAt = base.proposal.value.resolvedAt as string;
  const hours = opts.timelockHours ?? 24;
  const applyAt = opts.noWindow ? null : applyAtFrom(resolvedAt, hours);

  if (!opts.omitSettings) {
    await community.put(SETTINGS_COLLECTION, 'self', {
      $type: SETTINGS_COLLECTION,
      displayName: 'Test Community',
      governanceModel: 'simple-majority',
      governanceConfig: {
        quorum: 3,
        voterRole: 'moderator',
        timelockHours: hours,
        ...(opts.objectionThreshold !== undefined ? { objectionThreshold: opts.objectionThreshold } : {}),
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }

  // Objectors sign in their own repos, citing the decision under contest.
  const objectors = new Map<string, TestRepo>();
  const withheld = new Set<string>();
  const cached: Array<Record<string, unknown>> = [];
  for (const spec of opts.objections ?? []) {
    const repo = await TestRepo.create(`did:plc:objector${spec.name}aaaaaaaa`);
    objectors.set(spec.name, repo);
    if (spec.withholdRepo) withheld.add(spec.name);

    const createdAt = applyAtFrom(resolvedAt, spec.atHours ?? Math.max(hours / 2, 0.5));
    const rkey = `3lobj${spec.name}`;
    let cid: string | null = null;
    if (!spec.cacheOnly) {
      cid = await repo.put(OBJECTION_COLLECTION, rkey, {
        $type: OBJECTION_COLLECTION,
        community: community.did,
        proposal: { uri: base.proposalUri, cid: base.proposal.cid },
        proposalCollection: PROPOSAL_COLLECTION,
        proposalRkey: PROPOSAL_RKEY,
        decision: {
          uri: base.decision.uri,
          cid: spec.wrongDecision ? base.proposal.cid : base.decision.cid,
        },
        reason: `${spec.name} objects`,
        createdAt,
      });
    }
    cached.push({
      objector: repo.did,
      record: { uri: `at://${repo.did}/${OBJECTION_COLLECTION}/${rkey}`, cid: cid ?? base.decision.cid },
      createdAt,
    });
  }

  // The timelock rewrite, as `voteOnProposal` and `applyIfDue` write it.
  const value: Record<string, unknown> = { ...base.proposal.value };
  if (applyAt) value.applyAt = applyAt;
  if (opts.state === 'rejected') {
    value.status = 'rejected';
  } else if (opts.state === 'pending-application') {
    value.status = 'pending-application';
  } else if (opts.state === 'objected') {
    value.status = 'objected';
    value.objections = cached;
  } else {
    value.status = 'approved';
    const appliedAt = opts.appliedAt === null
      ? null
      : opts.appliedAt ?? (applyAt ? applyAtFrom(applyAt, 1 / 60) : null);
    if (appliedAt) value.appliedAt = appliedAt;
  }
  const proposalCid = await community.put(PROPOSAL_COLLECTION, PROPOSAL_RKEY, value);

  const scenario: ApplicationScenario = {
    community,
    objectors,
    resolvedAt,
    applyAt,
    proposal: { uri: base.proposalUri, cid: proposalCid, value },
    input(overrides: Partial<VerifyApplicationInput> = {}): VerifyApplicationInput {
      const repos: TestRepo[] = [community];
      for (const [name, repo] of objectors) if (!withheld.has(name)) repos.push(repo);
      return {
        proposal: scenario.proposal,
        repos: repos.map(r => r.proof()) as RepoProof[],
        didDocuments: repos.map(r => r.didDoc()) as DidDocumentLike[],
        ...overrides,
      };
    },
  };
  return scenario;
}
