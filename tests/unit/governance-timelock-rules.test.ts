/**
 * The timelock rules, checked without a clock (#197).
 *
 * `checkObjectionRecord` is the predicate that decides whether an objection
 * holds an application, and it is applied both by the submitting endpoint and
 * by the lazy application path — so the cases that matter (late, early, naming
 * some other decision) are pinned here as pure inputs rather than being
 * inferred from a running server's timing.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMELOCK_HOURS,
  PROPOSAL_COLLECTION,
  applyAtFrom,
  checkObjectionRecord,
  timelockHours,
} from '../../src/governance/decision-rules.js';

const COMMUNITY = 'did:plc:community000000000000';
const PROPOSAL_URI = `at://${COMMUNITY}/${PROPOSAL_COLLECTION}/3kabc`;
const DECISION_URI = `at://${COMMUNITY}/net.openfederation.governance.decision/3kdec`;
const DECISION_CID = 'bafydecision';

const ctx = {
  proposalUri: PROPOSAL_URI,
  decisionUri: DECISION_URI,
  decisionCid: DECISION_CID,
  resolvedAt: '2026-01-01T00:00:00.000Z',
  applyAt: '2026-01-02T00:00:00.000Z',
};

function objection(overrides: Record<string, unknown> = {}) {
  return {
    community: COMMUNITY,
    proposal: { uri: PROPOSAL_URI, cid: 'bafyproposal' },
    proposalCollection: PROPOSAL_COLLECTION,
    proposalRkey: '3kabc',
    decision: { uri: DECISION_URI, cid: DECISION_CID },
    createdAt: '2026-01-01T06:00:00.000Z',
    ...overrides,
  };
}

describe('timelock configuration', () => {
  it('defaults to the standard window when the community states nothing', () => {
    expect(timelockHours(undefined)).toBe(DEFAULT_TIMELOCK_HOURS);
    expect(timelockHours({})).toBe(DEFAULT_TIMELOCK_HOURS);
    expect(timelockHours({ governanceConfig: {} })).toBe(DEFAULT_TIMELOCK_HOURS);
  });

  it('never lets a malformed value shorten the window', () => {
    for (const bad of ['0', -1, Number.NaN, null, {}]) {
      expect(timelockHours({ governanceConfig: { timelockHours: bad } })).toBe(DEFAULT_TIMELOCK_HOURS);
    }
  });

  it('honours an explicit window, including an explicit zero', () => {
    expect(timelockHours({ governanceConfig: { timelockHours: 0 } })).toBe(0);
    expect(timelockHours({ governanceConfig: { timelockHours: 72 } })).toBe(72);
    expect(timelockHours({ governanceConfig: { timelockHours: 0.5 } })).toBe(0.5);
  });

  it('computes the applicable instant from the resolution time', () => {
    expect(applyAtFrom('2026-01-01T00:00:00.000Z', 24)).toBe('2026-01-02T00:00:00.000Z');
    expect(applyAtFrom('2026-01-01T00:00:00.000Z', 0.5)).toBe('2026-01-01T00:30:00.000Z');
  });
});

describe('checkObjectionRecord', () => {
  it('counts an objection raised inside the window against the right decision', () => {
    const result = checkObjectionRecord(objection(), ctx);
    expect(result).toEqual({ countable: true, createdAt: '2026-01-01T06:00:00.000Z' });
  });

  it('does not count an objection raised at or after the applicable instant', () => {
    expect(checkObjectionRecord(objection({ createdAt: ctx.applyAt }), ctx))
      .toEqual({ countable: false, reason: 'late-objection' });
    expect(checkObjectionRecord(objection({ createdAt: '2026-01-03T00:00:00.000Z' }), ctx))
      .toEqual({ countable: false, reason: 'late-objection' });
  });

  it('does not count an objection that predates the decision it contests', () => {
    expect(checkObjectionRecord(objection({ createdAt: '2025-12-31T23:59:59.000Z' }), ctx))
      .toEqual({ countable: false, reason: 'objection-predates-decision' });
    expect(checkObjectionRecord(objection({ createdAt: undefined }), ctx))
      .toEqual({ countable: false, reason: 'objection-predates-decision' });
  });

  it('does not count an objection naming another proposal', () => {
    expect(checkObjectionRecord(objection({ proposal: { uri: `at://${COMMUNITY}/${PROPOSAL_COLLECTION}/other`, cid: 'x' } }), ctx))
      .toEqual({ countable: false, reason: 'proposal-uri-mismatch' });
    expect(checkObjectionRecord(objection({ proposalCollection: 'app.example.other' }), ctx))
      .toEqual({ countable: false, reason: 'proposal-uri-mismatch' });
  });

  it('does not count an objection naming another decision, or another state of it', () => {
    expect(checkObjectionRecord(objection({ decision: { uri: DECISION_URI, cid: 'bafyother' } }), ctx))
      .toEqual({ countable: false, reason: 'decision-mismatch' });
    expect(checkObjectionRecord(objection({ decision: undefined }), ctx))
      .toEqual({ countable: false, reason: 'decision-mismatch' });
  });
});
