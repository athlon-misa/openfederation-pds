import { describe, expect, it } from 'vitest';
import { parseAdminFilters, updateAdminQuery } from '../../web-interface/src/lib/admin-filters';

describe('admin user filters', () => {
  it('opens pending approvals from a dashboard link', () => {
    expect(parseAdminFilters(new URLSearchParams('status=pending'))).toEqual({ status: 'pending', role: '', search: '', page: 0 });
  });
  it('restores valid filters and one-based page URLs', () => {
    expect(parseAdminFilters(new URLSearchParams('status=approved&role=auditor&q=alice&page=3'))).toEqual({ status: 'approved', role: 'auditor', search: 'alice', page: 2 });
  });
  it('ignores invalid filters and unsafe or malformed pages', () => {
    for (const page of ['-1', '0', '1.2', 'NaN', '1e10', '9007199254740999']) {
      expect(parseAdminFilters(new URLSearchParams(`status=bad&role=owner&page=${page}`))).toEqual({ status: '', role: '', search: '', page: 0 });
    }
  });
  it('resets pagination when a filter changes and preserves unrelated parameters', () => {
    const next = updateAdminQuery(new URLSearchParams('page=4&status=approved&ref=dashboard'), { status: 'pending' });
    expect(next.get('status')).toBe('pending');
    expect(next.has('page')).toBe(false);
    expect(next.get('ref')).toBe('dashboard');
  });
  it('clears filters without leaving all or empty query values', () => {
    const next = updateAdminQuery(new URLSearchParams('page=4&status=pending&role=admin&q=alice'), { status: '', role: '', search: '' });
    expect(next.toString()).toBe('');
  });
  it('encodes searches safely and preserves filters when paging', () => {
    const next = updateAdminQuery(new URLSearchParams('status=pending'), { search: 'a&role=admin' });
    expect(parseAdminFilters(next).search).toBe('a&role=admin');
    expect(next.has('role')).toBe(false);
    expect(updateAdminQuery(next, { page: 2 }).get('page')).toBe('3');
  });
});
