import { describe, it, expect } from 'vitest';
import { parsePagination } from '../../src/xrpc/pagination.js';

describe('parsePagination', () => {
  it('defaults to 50 with no limit', () => {
    expect(parsePagination({})).toEqual({ limit: 50, cursor: undefined });
  });

  it('parses a valid limit', () => {
    expect(parsePagination({ limit: '25' }).limit).toBe(25);
  });

  it('clamps to maxLimit (default 100)', () => {
    expect(parsePagination({ limit: '9999' }).limit).toBe(100);
  });

  it('clamps to minimum 1', () => {
    expect(parsePagination({ limit: '-5' }).limit).toBe(1);
  });

  // preserves the legacy `|| default` semantics of the copy-pasted line
  it('falls back to default for "0" and garbage', () => {
    expect(parsePagination({ limit: '0' }).limit).toBe(50);
    expect(parsePagination({ limit: 'abc' }).limit).toBe(50);
  });

  it('passes cursor through when a non-empty string', () => {
    expect(parsePagination({ cursor: 'abc' }).cursor).toBe('abc');
    expect(parsePagination({ cursor: '' }).cursor).toBeUndefined();
    expect(parsePagination({}).cursor).toBeUndefined();
  });

  it('honors custom defaults', () => {
    expect(parsePagination({}, { defaultLimit: 20, maxLimit: 40 }).limit).toBe(20);
    expect(parsePagination({ limit: '99' }, { defaultLimit: 20, maxLimit: 40 }).limit).toBe(40);
  });
});
