import { describe, expect, it } from 'vitest';
import { checkGovernanceSettings } from '../../src/governance/settings-rules.js';

const voting = (config: Record<string, unknown>) => checkGovernanceSettings({
  governanceModel: 'simple-majority',
  governanceConfig: { quorum: 2, voterRole: 'moderator', ...config },
});

describe('governance settings that would break a community are refused', () => {
  it('quorum must be a whole number', () => {
    expect(voting({ quorum: 1.5 })?.message).toMatch(/quorum/);
    expect(voting({ quorum: Number.POSITIVE_INFINITY })?.message).toMatch(/quorum/);
    expect(voting({ quorum: 2 })).toBeNull();
  });

  it('proposalTtlDays must be a usable number of days', () => {
    // A non-number made every createProposal throw on an invalid date.
    expect(voting({ proposalTtlDays: 'soon' })?.message).toMatch(/proposalTtlDays/);
    expect(voting({ proposalTtlDays: 0 })?.message).toMatch(/proposalTtlDays/);
    expect(voting({ proposalTtlDays: -3 })?.message).toMatch(/proposalTtlDays/);
    expect(voting({ proposalTtlDays: 100000 })?.message).toMatch(/proposalTtlDays/);
    expect(voting({ proposalTtlDays: 7 })).toBeNull();
    expect(voting({})).toBeNull();
  });

  it('timelockHours has an upper bound', () => {
    // A huge value made the apply date overflow at resolution, after votes were recorded.
    expect(voting({ timelockHours: 1e12 })?.message).toMatch(/timelockHours/);
    expect(voting({ timelockHours: 72 })).toBeNull();
    expect(voting({ timelockHours: 0 })).toBeNull();
  });
});
