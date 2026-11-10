import { describe, it, expect } from 'vitest';
import { api } from './helpers.js';

describe('GET /.well-known/security.txt', () => {
  it('serves RFC 9116 contact details as plain text', async () => {
    const res = await api.get('/.well-known/security.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/^Contact: /m);
    expect(res.text).toMatch(/^Expires: \d{4}-\d{2}-\d{2}T/m);
  });
});
