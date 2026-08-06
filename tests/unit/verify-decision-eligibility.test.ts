/**
 * Voter eligibility is evidence, not an assumption (#200).
 *
 * Before this, a decision citing five authentic, well-formed votes from five
 * DIDs that were never members verified as `valid` — the tally's account of who
 * the electorate was went entirely unchecked.
 *
 * A vote now carries the community-signed member and role records consulted when
 * it was cast, and the verifier rechecks them against the community's own repo.
 * The three outcomes are deliberately distinct, and the tests below are grouped
 * that way:
 *
 *   ok            records present at the cited CIDs, role carries the permission
 *   ineligible    the records are present and disprove the claim  -> a problem
 *   unverifiable  the evidence is gone or was never recorded      -> a note
 */
import { describe, it, expect } from 'vitest';
import { buildScenario } from './helpers/governance-decision-fixture.js';
import { verifyDecision } from '../../src/governance/verify-decision.js';
import {
  GOVERNANCE_WRITE_PERMISSION,
  LEGACY_ROLE_PERMISSIONS,
} from '../../src/governance/decision-rules.js';
import { PERMISSIONS, ALL_PERMISSIONS } from '../../src/auth/permissions.js';

const codes = (items: Array<{ code: string }>) => items.map(i => i.code);

describe('the shared permission constants stay in step with the auth layer', () => {
  it('names the same permission string the live check uses', () => {
    // decision-rules.ts deliberately does not import from src/auth (it must stay
    // free of the database layer), so this is what stops the two drifting.
    expect(GOVERNANCE_WRITE_PERMISSION).toBe(PERMISSIONS.GOVERNANCE_WRITE);
  });

  it('gives owner exactly the full permission set', () => {
    expect([...LEGACY_ROLE_PERMISSIONS.owner].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('does not give a plain member the vote', () => {
    expect(LEGACY_ROLE_PERMISSIONS.member).not.toContain(GOVERNANCE_WRITE_PERMISSION);
    expect(LEGACY_ROLE_PERMISSIONS.moderator).toContain(GOVERNANCE_WRITE_PERMISSION);
  });
});

describe('eligibility that checks out', () => {
  it('verifies when an assigned role record grants governance.write', async () => {
    const s = await buildScenario({ eligibility: 'role' });
    const result = await verifyDecision(s.input());
    expect(result.problems).toEqual([]);
    expect(result.status).toBe('valid');
    expect(codes(result.notes)).not.toContain('membership-unverified');
  });

  it('verifies a built-in role with no role record', async () => {
    const s = await buildScenario({ eligibility: 'legacy' });
    const result = await verifyDecision(s.input());
    expect(result.problems).toEqual([]);
    expect(result.status).toBe('valid');
  });
});

describe('eligibility the evidence disproves', () => {
  it("rejects a vote whose role record does not carry the permission", async () => {
    const s = await buildScenario({ eligibility: 'no-perm' });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('invalid');
    expect(codes(result.problems)).toContain('ineligible-vote');
    expect(result.problems[0].message).toMatch(/did not carry community\.governance\.write/);
  });

  it('rejects a vote claiming a permission its own evidence denies', async () => {
    const s = await buildScenario({
      eligibility: 'no-perm',
      // Claim the permission anyway — the cited role record still says otherwise.
      mutateEligibility: (e) => { e.grantedGovernanceWrite = true; },
    });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('invalid');
    expect(codes(result.problems)).toContain('ineligible-vote');
    expect(result.problems[0].message).toMatch(/does not carry community\.governance\.write/);
  });

  it('rejects membership evidence pointing at another community', async () => {
    const s = await buildScenario({
      eligibility: 'role',
      mutateEligibility: (e) => {
        e.member.uri = e.member.uri.replace('did:plc:communityaaaaaaaaaaaa', 'did:plc:someoneelseaaaaaaaaa');
      },
    });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('invalid');
    expect(result.problems[0].message).toMatch(/not the deciding community/);
  });

  it('rejects a legacy claim the member record contradicts', async () => {
    const s = await buildScenario({
      eligibility: 'legacy',
      mutateEligibility: (e) => { e.roleName = 'owner'; }, // record says moderator
    });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('invalid');
    expect(result.problems[0].message).toMatch(/but the member record says "moderator"/);
  });

  it('rejects a role record other than the one the member is assigned', async () => {
    const s = await buildScenario({
      eligibility: 'role',
      mutateEligibility: (e) => {
        e.roleRecord.uri = e.roleRecord.uri.replace('3lrolemoderator', '3lroleplanted');
      },
    });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('invalid');
    expect(result.problems[0].message).toMatch(/but the member record assigns 3lrolemoderator/);
  });
});

describe('eligibility that cannot be rechecked', () => {
  it('notes, rather than fails, a vote written before evidence existed', async () => {
    // Backward compatibility: every vote recorded before #200 carries none.
    const s = await buildScenario();
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('valid');
    expect(codes(result.notes)).toContain('membership-unverified');
    expect(result.notes.find(n => n.code === 'membership-unverified')!.message)
      .toMatch(/carries no membership evidence/);
  });

  it('notes a member record that has since changed', async () => {
    const s = await buildScenario({
      eligibility: 'role',
      mutateEligibility: (e) => {
        // A plausible but stale CID: the record moved on after the vote.
        e.member.cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      },
    });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('valid');
    expect(codes(result.notes)).toContain('membership-unverified');
    expect(result.notes.find(n => n.code === 'membership-unverified')!.message)
      .toMatch(/has changed since the vote/);
  });

  it('notes a member record absent from the community export', async () => {
    const s = await buildScenario({
      eligibility: 'role',
      mutateEligibility: (e) => {
        e.member.uri = e.member.uri.replace(/3lmember\w+$/, '3lmembergone');
      },
    });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('valid');
    expect(codes(result.notes)).toContain('membership-unverified');
  });

  it('notes evidence the writer could not assemble', async () => {
    const s = await buildScenario({
      eligibility: 'role',
      mutateEligibility: (e) => { e.unresolved = 'no-member-record'; },
    });
    const result = await verifyDecision(s.input());
    expect(result.status).toBe('valid');
    expect(result.notes.find(n => n.code === 'membership-unverified')!.message)
      .toMatch(/not assembled when the vote was cast \(no-member-record\)/);
  });

  it('never lets an unverifiable membership claim read as verified', async () => {
    const s = await buildScenario();
    const result = await verifyDecision(s.input());
    // `valid` here means "the decision is sound on the evidence supplied" — the
    // note is what tells a consumer the electorate was not among that evidence.
    expect(result.status).toBe('valid');
    expect(result.notes.length).toBeGreaterThan(0);
  });
});
