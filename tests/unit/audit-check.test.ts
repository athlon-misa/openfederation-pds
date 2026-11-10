import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM script without types
import { checkAudit } from '../../scripts/audit-check.mjs';

const report = (...vias: Array<{ url: string; severity: string; name: string }>) => ({
  vulnerabilities: { pkg: { via: vias.map((v) => ({ ...v, title: 't' })) } },
});
const allow = (review_by = '2099-01-01') => ({ accepted: [{ id: 'GHSA-aaaa', package: 'a', reason: 'r', review_by }] });

describe('audit-check', () => {
  it('passes when every high/critical advisory is accepted', () => {
    const r = checkAudit(report({ url: 'https://github.com/advisories/GHSA-aaaa', severity: 'high', name: 'a' }), allow());
    expect(r.unaccepted).toEqual([]);
    expect(r.expired).toEqual([]);
  });
  it('fails on a new high advisory', () => {
    const r = checkAudit(report({ url: 'https://github.com/advisories/GHSA-bbbb', severity: 'critical', name: 'b' }), allow());
    expect(r.unaccepted.map((f: { id: string }) => f.id)).toEqual(['GHSA-bbbb']);
  });
  it('ignores moderate and low advisories', () => {
    const r = checkAudit(report({ url: 'https://github.com/advisories/GHSA-cccc', severity: 'moderate', name: 'c' }), allow());
    expect(r.found).toEqual([]);
  });
  it('fails when an accepted advisory is past its review date', () => {
    const r = checkAudit(report({ url: 'https://github.com/advisories/GHSA-aaaa', severity: 'high', name: 'a' }), allow('2020-01-01'));
    expect(r.expired).toHaveLength(1);
  });
});
