/**
 * federation.listPeerCommunities never lets a peer speak for a community
 * hosted here: a peer could otherwise list one of our private communities, or
 * rename a public one, on our own server's page.
 */
import { describe, it, expect, vi } from 'vitest';

const hostedHere = 'did:web:ours.example';
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: (params[0] as string[]).filter((did) => did === hostedHere).map((did) => ({ did })),
  })),
}));
vi.mock('../../src/federation/peer-cache.js', () => ({
  getCachedPeerInfo: vi.fn(async () => []),
  getCachedPeerCommunities: vi.fn(async () => ({
    cachedAt: 0,
    communities: [
      { did: hostedHere, handle: 'impostor.example', displayName: 'Impostor' },
      { did: 'did:web:theirs.example', handle: 'theirs.example', displayName: 'Theirs' },
    ],
  })),
}));

const { default: listPeerCommunities } = await import('../../src/api/net.openfederation.federation.listPeerCommunities.js');

describe('federation.listPeerCommunities', () => {
  it('drops peer entries for communities hosted here', async () => {
    let body: any;
    const res = { status: vi.fn(() => res), json: vi.fn((b: unknown) => { body = b; }) } as any;
    await listPeerCommunities({} as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.communities.map((c: any) => c.did)).toEqual(['did:web:theirs.example']);
  });
});
