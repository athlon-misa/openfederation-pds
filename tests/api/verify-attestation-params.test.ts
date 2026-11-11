import { describe, it, expect } from 'vitest';
import { api } from './helpers.js';

describe('community.verifyAttestation parameters', () => {
  it('refuses a repeated communityDid (an array, not a string)', async () => {
    const res = await api.get('/xrpc/net.openfederation.community.verifyAttestation?communityDid=did:web:a.example&communityDid=did:web:b.example&rkey=x');
    expect(res.status).toBe(400);
  });
});
