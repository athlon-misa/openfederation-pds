/**
 * Offline decision verification (#196).
 *
 * Everything here runs against *real* signed repos: real secp256k1 keypairs,
 * real MST commits from `@atproto/repo`, real CIDs. Nothing is stubbed, because
 * the claim under test is a cryptographic one — a mocked signature would let a
 * "valid" verdict be assumed rather than earned.
 */
import { describe, it, expect } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  PROPOSAL_COLLECTION,
  VOTE_COLLECTION,
  DECISION_COLLECTION,
} from '../../src/governance/decision-rules.js';
import { verifyDecision, type CitedRecord } from '../../src/governance/verify-decision.js';
import { TestRepo, buildScenario, PROPOSAL_RKEY } from './helpers/governance-decision-fixture.js';

// ── Happy path ──────────────────────────────────────────────────────

describe('verifyDecision — a decision that earns its verdict', () => {
  it('verifies a decision against real signed repos', async () => {
    const s = await buildScenario();
    const verdict = await verifyDecision(s.input());

    expect(verdict.problems).toEqual([]);
    expect(verdict.status).toBe('valid');
    expect(verdict.code).toBe('valid');
    expect(verdict.summary.verifiedVotes).toBe(3);
    expect(verdict.summary.citedVotes).toBe(3);
    expect(verdict.summary.countedFor).toBe(3);
    expect(verdict.summary.eligibleVotesFound).toBe(3);
    expect(verdict.summary.outcome).toBe('approved');
  });

  it('verifies a rejection the same way', async () => {
    const s = await buildScenario({ choices: ['for', 'against', 'against'] });
    const verdict = await verifyDecision(s.input());
    expect(verdict.status).toBe('valid');
    expect(verdict.summary.outcome).toBe('rejected');
  });

  it('reaches no database or network — the input is the whole world', async () => {
    // Nothing in the module graph of the verifier may pull in the pg client.
    const mod = await import('../../src/governance/verify-decision.js');
    expect(typeof mod.verifyDecision).toBe('function');
    const s = await buildScenario();
    // Deliberately run with DB config that could not possibly connect.
    const previous = process.env.DB_HOST;
    process.env.DB_HOST = 'unreachable.invalid';
    try {
      expect((await verifyDecision(s.input())).status).toBe('valid');
    } finally {
      if (previous === undefined) delete process.env.DB_HOST; else process.env.DB_HOST = previous;
    }
  });
});

// ── Failure taxonomy ────────────────────────────────────────────────

describe('verifyDecision — tampered-vote', () => {
  it('catches a vote record rewritten after the decision cited it', async () => {
    const s = await buildScenario();
    const alice = s.voters[0];
    // The voter's repo is re-signed with a *different* vote at the same rkey.
    await alice.repo.put(VOTE_COLLECTION, alice.rkey, {
      $type: VOTE_COLLECTION,
      community: s.community.did,
      proposal: { uri: s.proposalUri, cid: (s.proposal.value.cidChain as string[])[0] },
      proposalCollection: PROPOSAL_COLLECTION,
      proposalRkey: PROPOSAL_RKEY,
      vote: 'against',
      createdAt: alice.castAt,
    });

    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('tampered-vote');
    expect(verdict.problems[0].voter).toBe(alice.repo.did);
    expect(verdict.problems[0].message).toMatch(/signed repo holds/);
    expect(verdict.summary.verifiedVotes).toBe(2);
  });

  it('catches a decision that misreports how someone voted', async () => {
    const s = await buildScenario({
      mutateDecision: d => { d.votes[1].vote = 'against'; d.tally = { votesFor: 2, votesAgainst: 1, total: 3 }; },
    });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('tampered-vote');
    expect(verdict.problems[0].message).toMatch(/the signed record says "for"/);
  });

  it('catches a cited vote that is not in the voter\'s repo at all', async () => {
    const s = await buildScenario({
      mutateDecision: d => { d.votes[2].record.uri = d.votes[2].record.uri.replace(/3lvote\w+$/, '3lvoteghost'); },
    });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('tampered-vote');
    expect(verdict.problems[0].message).toMatch(/not present in the signed repo/);
  });
});

describe('verifyDecision — forged-signature', () => {
  it('rejects a repo whose commit was not signed by the DID\'s atproto key', async () => {
    const s = await buildScenario();
    const impostor = await Secp256k1Keypair.create();
    const input = s.input();
    // The DID document publishes a key that did not sign this repo.
    input.didDocuments = input.didDocuments.map(doc =>
      doc.id === s.voters[2].repo.did ? s.voters[2].repo.didDoc(impostor) : doc,
    );

    const verdict = await verifyDecision(input);
    expect(verdict.code).toBe('forged-signature');
    expect(verdict.problems[0].voter).toBe(s.voters[2].repo.did);
    // An unverifiable repo proves nothing, so its vote is neither counted as
    // verified nor used to claim a vote was missed.
    expect(verdict.summary.verifiedVotes).toBe(2);
    expect(verdict.problems.some(p => p.code === 'uncounted-vote')).toBe(false);
  });

  it('rejects an export whose commit names a different DID', async () => {
    const s = await buildScenario();
    const input = s.input();
    const bob = s.voters[1].repo;
    input.repos = input.repos.map(p => (p.did === bob.did ? { ...p, did: 'did:plc:someoneelseaaaaaaaa' } : p));
    const verdict = await verifyDecision(input);
    expect(verdict.code).toBe('forged-signature');
    expect(verdict.problems[0].message).toMatch(/its signed commit names/);
  });
});

describe('verifyDecision — insufficient-quorum', () => {
  it('rejects a decision resolved below its own published threshold', async () => {
    const s = await buildScenario({ quorum: 5 });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('insufficient-quorum');
    expect(verdict.problems[0].message).toMatch(/below the quorum threshold of 5/);
    // Everything else about the decision is sound.
    expect(verdict.problems).toHaveLength(1);
  });

  it('rejects a decision that publishes a threshold its community does not have', async () => {
    // The attack the published threshold alone cannot catch: a PDS resolves a
    // one-vote decision in a quorum-five community and writes `threshold: 1`.
    const s = await buildScenario({ choices: ['for'], quorum: 1, settingsQuorum: 5 });
    const verdict = await verifyDecision(s.input());

    expect(verdict.status).toBe('invalid');
    expect(verdict.code).toBe('insufficient-quorum');
    expect(verdict.problems[0].message).toMatch(/required by the community's settings record, though the decision publishes 1/);
    expect(verdict.summary.quorumThreshold).toBe(1);
    expect(verdict.summary.settingsQuorumThreshold).toBe(5);
    expect(verdict.summary.effectiveQuorumThreshold).toBe(5);
  });

  it('applies the same `|| 3` default the online path uses', async () => {
    const s = await buildScenario({ choices: ['for', 'for'], quorum: 2, settingsQuorum: 0 });
    const verdict = await verifyDecision(s.input());
    expect(verdict.summary.settingsQuorumThreshold).toBe(3);
    expect(verdict.code).toBe('insufficient-quorum');
  });

  it('notes a threshold disagreement that the tally still satisfies', async () => {
    // The community lowered its quorum after the fact. The decision still
    // clears the stricter of the two, so this is disclosed, not rejected.
    const s = await buildScenario({ quorum: 3, settingsQuorum: 2 });
    const verdict = await verifyDecision(s.input());
    expect(verdict.status).toBe('valid');
    expect(verdict.notes.some(n => n.code === 'quorum-rule-drift')).toBe(true);
    expect(verdict.summary.effectiveQuorumThreshold).toBe(3);
  });

  it('cannot check the community rule when the settings record is absent', async () => {
    const s = await buildScenario({ omitSettings: true });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('missing-evidence');
    expect(verdict.problems[0].message).toMatch(/community settings record/);
    expect(verdict.summary.settingsQuorumThreshold).toBeNull();
  });
});

describe('verifyDecision — uncounted-vote', () => {
  it('rejects a decision that ignores an eligible vote present in the evidence', async () => {
    const s = await buildScenario({ uncited: ['against'] });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('uncounted-vote');
    expect(verdict.problems[0].voter).toBe(s.extraVoters[0].repo.did);
    expect(verdict.summary.eligibleVotesFound).toBe(4);
    expect(verdict.summary.citedVotes).toBe(3);
  });
});

describe('verifyDecision — ineligible-vote', () => {
  it('rejects a counted vote citing a proposal state that never existed', async () => {
    const s = await buildScenario({ breakLineageFor: 1 });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('ineligible-vote');
    expect(verdict.problems[0].message).toMatch(/unknown-proposal-cid/);
  });
});

describe('verifyDecision — arithmetic', () => {
  it('rejects a tally that does not match the votes cited', async () => {
    const s = await buildScenario({ mutateDecision: d => { d.tally.votesFor = 4; d.tally.total = 4; } });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('miscounted-tally');
  });

  it('rejects an outcome the published rule does not produce', async () => {
    const s = await buildScenario({ choices: ['for', 'against', 'against'], outcome: 'approved' });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('wrong-outcome');
    expect(verdict.problems[0].message).toMatch(/yields "rejected"/);
  });
});

describe('verifyDecision — malformed and missing', () => {
  it('rejects a decision whose evidenceComplete contradicts its uncountedVotes', async () => {
    const s = await buildScenario({
      mutateDecision: d => { d.uncountedVotes = [{ voter: 'did:plc:ghost', vote: 'for', reason: 'no-vote-record' }]; },
    });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('malformed-decision');
    expect(verdict.problems[0].message).toMatch(/evidenceComplete is true/);
  });

  it('rejects a decision that counts the same voter twice', async () => {
    const s = await buildScenario({
      mutateDecision: d => {
        d.votes.push({ ...d.votes[0] });
        d.tally = { votesFor: 4, votesAgainst: 0, total: 4 };
      },
    });
    const verdict = await verifyDecision(s.input());
    expect(verdict.code).toBe('malformed-decision');
    expect(verdict.problems[0].message).toMatch(/counted more than once/);
  });

  it('reports missing evidence distinctly from tampering', async () => {
    const s = await buildScenario();
    const input = s.input();
    const bob = s.voters[1].repo.did;
    input.repos = input.repos.filter(p => p.did !== bob);
    input.didDocuments = input.didDocuments.filter(d => d.id !== bob);

    const verdict = await verifyDecision(input);
    expect(verdict.code).toBe('missing-evidence');
    expect(verdict.problems[0].message).toMatch(/no repo export supplied for voter/);
    expect(verdict.summary.verifiedVotes).toBe(2);
  });

  it('rejects a decision record that does not hash to its cited CID', async () => {
    const s = await buildScenario();
    const input = s.input();
    input.decision = { ...s.decision, value: { ...s.decision.value, outcome: 'rejected' } };
    const verdict = await verifyDecision(input);
    expect(verdict.code).toBe('tampered-evidence');
  });

  it('rejects a proposal record that does not hash to its cited CID', async () => {
    const s = await buildScenario();
    const input = s.input();
    input.proposal = { ...s.proposal, value: { ...s.proposal.value, status: 'open' } };
    const verdict = await verifyDecision(input);
    expect(verdict.code).toBe('tampered-evidence');
  });
});

// ── Realities that are not corruption ───────────────────────────────

describe('verifyDecision — legitimate states', () => {
  it('reports a superseded decision as superseded, not as short of votes', async () => {
    // A crash between the decision write and the status rewrite: a later vote
    // lands, and a second decision supersedes the first.
    const s = await buildScenario();
    const dave = await TestRepo.create('did:plc:voterdaveaaaaaaaaaaaa');
    const lineage = [...(s.proposal.value.cidChain as string[]), s.proposal.cid];
    const daveVoteCid = await dave.put(VOTE_COLLECTION, '3lvotedave', {
      $type: VOTE_COLLECTION,
      community: s.community.did,
      proposal: { uri: s.proposalUri, cid: s.proposal.cid },
      proposalCollection: PROPOSAL_COLLECTION,
      proposalRkey: PROPOSAL_RKEY,
      vote: 'against',
      createdAt: '2026-01-01T02:00:00.000Z',
    });

    const secondValue = {
      ...s.decision.value,
      votes: [
        ...(s.decision.value.votes as any[]),
        {
          voter: dave.did,
          vote: 'against',
          record: { uri: `at://${dave.did}/${VOTE_COLLECTION}/3lvotedave`, cid: daveVoteCid },
          proposalCid: s.proposal.cid,
        },
      ],
      tally: { votesFor: 3, votesAgainst: 1, total: 4 },
      supersedes: { uri: s.decision.uri, cid: s.decision.cid },
      resolvedAt: '2026-01-01T02:00:01.000Z',
    };
    const secondRkey = '3laaaadecision2';
    const secondCid = await s.community.put(DECISION_COLLECTION, secondRkey, secondValue);
    const second: CitedRecord = {
      uri: `at://${s.community.did}/${DECISION_COLLECTION}/${secondRkey}`,
      cid: secondCid,
      value: secondValue,
    };

    const input = s.input();
    input.repos = [...input.repos, dave.proof()];
    input.didDocuments = [...input.didDocuments, dave.didDoc()];

    // Without the sibling, the older decision simply looks like it missed a vote.
    const blind = await verifyDecision(input);
    expect(blind.code).toBe('uncounted-vote');

    // With it, the staleness is explained rather than blamed.
    const verdict = await verifyDecision({ ...input, siblingDecisions: [second] });
    expect(verdict.status).toBe('superseded');
    expect(verdict.code).toBe('superseded');
    expect(verdict.problems).toEqual([]);
    expect(verdict.notes.some(n => n.code === 'uncounted-vote')).toBe(true);
    expect(verdict.summary.supersededBy).toBe(second.uri);
    expect(lineage.length).toBeGreaterThan(1);

    // And the replacement itself verifies outright.
    const replacement = await verifyDecision({
      ...input,
      decision: second,
      siblingDecisions: [s.decision],
    });
    expect(replacement.problems).toEqual([]);
    expect(replacement.status).toBe('valid');
  });

  it('ignores a fabricated sibling that is not in the community\'s signed repo', async () => {
    // Honouring a supersession excuses the exact failure this verifier exists
    // to raise, so a caller must not be able to conjure one. This sibling names
    // a uri that was never written and carries another record's cid.
    const s = await buildScenario({ uncited: ['against'] });
    const forged: CitedRecord = {
      uri: `at://${s.community.did}/${DECISION_COLLECTION}/3laaaaforged`,
      cid: s.decision.cid,
      value: { supersedes: { uri: s.decision.uri, cid: s.decision.cid }, proposalRkey: PROPOSAL_RKEY },
    };

    const verdict = await verifyDecision({ ...s.input(), siblingDecisions: [forged] });
    expect(verdict.status).toBe('invalid');
    expect(verdict.code).toBe('uncounted-vote');
    expect(verdict.summary.supersededBy).toBeUndefined();
  });

  it('ignores a real sibling record offered under the wrong cid', async () => {
    const s = await buildScenario({ uncited: ['against'] });
    const rkey = '3laaaadecision2';
    await s.community.put(DECISION_COLLECTION, rkey, {
      ...s.decision.value,
      supersedes: { uri: s.decision.uri, cid: s.decision.cid },
    });
    const sibling: CitedRecord = {
      // The record exists, but is offered at the *decision's* cid, not its own.
      uri: `at://${s.community.did}/${DECISION_COLLECTION}/${rkey}`,
      cid: s.decision.cid,
      value: { supersedes: { uri: s.decision.uri, cid: s.decision.cid } },
    };
    const verdict = await verifyDecision({ ...s.input(), siblingDecisions: [sibling] });
    expect(verdict.status).toBe('invalid');
    expect(verdict.code).toBe('uncounted-vote');
  });

  it('honours a genuine superseding decision written into the community repo', async () => {
    const s = await buildScenario({ uncited: ['against'] });
    const rkey = '3laaaadecision2';
    const value = { ...s.decision.value, supersedes: { uri: s.decision.uri, cid: s.decision.cid } };
    const cid = await s.community.put(DECISION_COLLECTION, rkey, value);

    const verdict = await verifyDecision({
      ...s.input(),
      siblingDecisions: [{ uri: `at://${s.community.did}/${DECISION_COLLECTION}/${rkey}`, cid, value }],
    });
    expect(verdict.status).toBe('superseded');
    expect(verdict.problems).toEqual([]);
    expect(verdict.notes.some(n => n.code === 'uncounted-vote')).toBe(true);
  });

  it('still fails a superseded decision that was also tampered with', async () => {
    const s = await buildScenario();
    const siblingRkey = '3laaaadecision2';
    const siblingValue = { ...s.decision.value, supersedes: { uri: s.decision.uri, cid: s.decision.cid } };
    const siblingCid = await s.community.put(DECISION_COLLECTION, siblingRkey, siblingValue);
    const sibling: CitedRecord = {
      uri: `at://${s.community.did}/${DECISION_COLLECTION}/${siblingRkey}`,
      cid: siblingCid,
      value: siblingValue,
    };
    const alice = s.voters[0];
    await alice.repo.put(VOTE_COLLECTION, alice.rkey, {
      $type: VOTE_COLLECTION,
      community: s.community.did,
      proposal: { uri: s.proposalUri, cid: (s.proposal.value.cidChain as string[])[0] },
      proposalCollection: PROPOSAL_COLLECTION,
      proposalRkey: PROPOSAL_RKEY,
      vote: 'against',
      createdAt: alice.castAt,
    });
    const verdict = await verifyDecision({ ...s.input(), siblingDecisions: [sibling] });
    expect(verdict.status).toBe('invalid');
    expect(verdict.code).toBe('tampered-vote');
  });

  it('verifies an orphan decision whose proposal later expired', async () => {
    const s = await buildScenario({ expireProposal: true });
    expect(s.proposal.value.status).toBe('expired');
    const verdict = await verifyDecision(s.input());
    expect(verdict.problems).toEqual([]);
    expect(verdict.status).toBe('valid');
  });

  it('accepts evidenceComplete: false and reports the disclosed gap as a note', async () => {
    const s = await buildScenario({ cacheOnly: ['did:plc:norepoaaaaaaaaaaaaa'] });
    expect(s.decision.value.evidenceComplete).toBe(false);
    const verdict = await verifyDecision(s.input());
    expect(verdict.problems).toEqual([]);
    expect(verdict.status).toBe('valid');
    expect(verdict.summary.disclosedUncounted).toBe(1);
    // Its own code — a consumer filtering for votes someone left out must not
    // trip over a gap the decision honestly declared.
    expect(verdict.notes.some(n => n.code === 'disclosed-gap')).toBe(true);
    expect(verdict.notes.some(n => n.code === 'uncounted-vote')).toBe(false);
  });
});
