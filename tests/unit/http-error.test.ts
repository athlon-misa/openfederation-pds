import { describe, it, expect } from 'vitest';
import { HttpError, renderXrpcError } from '../../src/xrpc/errors.js';

function mockRes() {
  const r: any = { statusCode: 200, body: null, headersSent: false };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; r.headersSent = true; return r; };
  return r;
}

describe('HttpError rendering', () => {
  it('renders status, code and message', () => {
    const res = mockRes();
    // NSID with no lexicon schema → all codes allowed
    renderXrpcError('test.unknown.method', res, new HttpError(403, 'Forbidden', 'nope'));
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', message: 'nope' });
  });

  it('falls back to 500 for non-HttpError values', () => {
    const res = mockRes();
    renderXrpcError('test.unknown.method', res, new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'InternalServerError', message: 'An internal error occurred' });
  });
});
