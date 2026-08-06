/**
 * The pure rules governing the override round (#199).
 *
 * These are the arithmetic a held proposal's fate turns on, and they run in
 * both places — the endpoints online, the verifier offline — so they are pinned
 * here on their own, without a database in the way.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OBJECTION_OVERRIDE_DAYS,
  decideOverride,
  objectionOverrideDays,
  objectionReviewMode,
  overrideExpiresAt,
  overrideQuorumFrom,
  tallyEpoch,
} from '../../src/governance/decision-rules.js';

const config = (governanceConfig: Record<string, unknown>) => ({ governanceConfig });

describe('objectionReviewMode', () => {
  it('re-reviews by default, including for a community with no settings at all', () => {
    expect(objectionReviewMode(undefined)).toBe('override');
    expect(objectionReviewMode({})).toBe('override');
    expect(objectionReviewMode(config({}))).toBe('override');
  });

  it('lets a community make a hold final, but only by saying so exactly', () => {
    expect(objectionReviewMode(config({ objectionReview: 'none' }))).toBe('none');
    // A typo must not silently hand one member a permanent veto. Every
    // unrecognized value is the safe direction, not the dangerous one.
    for (const typo of ['non', 'None', '', 0, null, true]) {
      expect(objectionReviewMode(config({ objectionReview: typo }))).toBe('override');
    }
  });
});

describe('overrideQuorumFrom', () => {
  it('asks two-thirds of the electorate', () => {
    // 12 eligible voters, quorum 3: two-thirds is 8, well above quorum+1.
    expect(overrideQuorumFrom(config({}), 3, 12)).toBe(8);
    expect(overrideQuorumFrom(config({}), 3, 10)).toBe(7);
  });

  it('never falls below quorum + 1', () => {
    // Two-thirds of 5 is 4, but a quorum of 6 would make the override *easier*
    // than the decision it is reviewing.
    expect(overrideQuorumFrom(config({}), 6, 5)).toBe(5);
    expect(overrideQuorumFrom(config({}), 4, 6)).toBe(5);
  });

  it('never asks for more votes than there are voters', () => {
    // The case that reinstates the permanent veto if it is got wrong: a
    // community whose quorum already equals its electorate has nothing stronger
    // than unanimity to ask for, and quorum+1 would be unreachable — so every
    // override would fail by construction, in exactly the small communities the
    // single-member veto hurts most.
    expect(overrideQuorumFrom(config({}), 3, 3)).toBe(3);
    expect(overrideQuorumFrom(config({}), 9, 3)).toBe(3);
  });

  it('never produces a bar of zero', () => {
    expect(overrideQuorumFrom(config({}), 3, 0)).toBe(1);
  });

  it('takes an explicit configured bar as stated', () => {
    expect(overrideQuorumFrom(config({ objectionOverrideQuorum: 2 }), 5, 20)).toBe(2);
    // Malformed values fall back rather than being coerced.
    for (const bad of [0, -1, 2.5, '4', null]) {
      expect(overrideQuorumFrom(config({ objectionOverrideQuorum: bad }), 3, 12)).toBe(8);
    }
  });
});

describe('objectionOverrideDays', () => {
  it('defaults, and refuses a window a round could never expire from', () => {
    expect(objectionOverrideDays(undefined)).toBe(DEFAULT_OBJECTION_OVERRIDE_DAYS);
    expect(objectionOverrideDays(config({ objectionOverrideDays: 0 }))).toBe(DEFAULT_OBJECTION_OVERRIDE_DAYS);
    expect(objectionOverrideDays(config({ objectionOverrideDays: -3 }))).toBe(DEFAULT_OBJECTION_OVERRIDE_DAYS);
    expect(objectionOverrideDays(config({ objectionOverrideDays: 2 }))).toBe(2);
  });
});

describe('overrideExpiresAt', () => {
  it('adds whole days to the instant the round opened', () => {
    expect(overrideExpiresAt('2026-01-01T00:00:00.000Z', 7)).toBe('2026-01-08T00:00:00.000Z');
    expect(overrideExpiresAt('2026-01-01T00:00:00.000Z', 0.5)).toBe('2026-01-01T12:00:00.000Z');
  });
});

describe('decideOverride', () => {
  it('carries only on reaching the bar, and never rejects from a vote', () => {
    expect(decideOverride(3, 4)).toBeNull();
    expect(decideOverride(4, 4)).toBe('approved');
    expect(decideOverride(9, 4)).toBe('approved');
    // Falling short is what the round's expiry decides, not a vote — so there
    // is no vote count that produces 'rejected' here.
    expect(decideOverride(0, 1)).toBeNull();
  });
});

describe('tallyEpoch', () => {
  it('starts a new epoch when an override round opens', () => {
    // Without this the first round's votes would count towards the higher bar —
    // clearing it with the very mandate that was objected to.
    expect(tallyEpoch({
      createdAt: '2026-01-01T00:00:00.000Z',
      overrideOpenedAt: '2026-01-05T00:00:00.000Z',
    })).toBe('2026-01-05T00:00:00.000Z');
  });

  it('takes the round over an earlier amendment', () => {
    expect(tallyEpoch({
      createdAt: '2026-01-01T00:00:00.000Z',
      amendments: [{ amendedAt: '2026-01-02T00:00:00.000Z' }],
      overrideOpenedAt: '2026-01-05T00:00:00.000Z',
    })).toBe('2026-01-05T00:00:00.000Z');
  });

  it('is unchanged for a proposal that never entered a round', () => {
    expect(tallyEpoch({ createdAt: '2026-01-01T00:00:00.000Z' })).toBe('2026-01-01T00:00:00.000Z');
    expect(tallyEpoch({
      createdAt: '2026-01-01T00:00:00.000Z',
      amendments: [{ amendedAt: '2026-01-02T00:00:00.000Z' }],
    })).toBe('2026-01-02T00:00:00.000Z');
  });
});
