import { afterEach, describe, expect, it, vi } from 'vitest';

const peer = 'https://1.1.1.1';

async function loadPeerCache(peerUrls = peer) {
  vi.resetModules();
  vi.stubEnv('PEER_PDS_URLS', peerUrls);
  vi.stubEnv('FEDERATION_CACHE_TTL_MS', '0');
  return import('../../src/federation/peer-cache.js');
}

function community(index: number) {
  return {
    did: `did:plc:community${index}`,
    handle: `community-${index}.example`,
    didMethod: 'plc',
    displayName: `Community ${index}`,
    description: '',
    visibility: 'public',
    joinPolicy: 'open',
    memberCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function streamedJsonResponse(data: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('peer cache outbound fetches', () => {
  it('does not cache peer info when the peer responds with a redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { getCachedPeerInfo } = await loadPeerCache();

    await expect(getCachedPeerInfo()).resolves.toEqual([
      { hostname: '1.1.1.1', serviceUrl: peer, webUrl: null, healthy: false },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
  });

  it('does not cache communities when a peer response exceeds 256 KiB', async () => {
    const oversizedCommunity = { ...community(1), description: 'x'.repeat(256 * 1024) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hostname: 'peer.example', serviceUrl: peer }))
      .mockResolvedValueOnce(streamedJsonResponse({ communities: [oversizedCommunity] }));
    vi.stubGlobal('fetch', fetchMock);
    const { getCachedPeerCommunities } = await loadPeerCache();

    await expect(getCachedPeerCommunities()).resolves.toMatchObject({ communities: [] });
  });

  it('retains no more than 100 communities from a peer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hostname: 'peer.example', serviceUrl: peer }))
      .mockResolvedValueOnce(jsonResponse({ communities: Array.from({ length: 101 }, (_, index) => community(index)) }));
    vi.stubGlobal('fetch', fetchMock);
    const { getCachedPeerCommunities } = await loadPeerCache();

    await expect(getCachedPeerCommunities()).resolves.toMatchObject({
      communities: Array.from({ length: 100 }, (_, index) => ({ did: `did:plc:community${index}` })),
    });
  });

  it('retains no more than 500 communities across peers', async () => {
    const peers = Array.from({ length: 6 }, (_, index) => `https://1.1.1.${index + 1}`);
    const fetchMock = vi.fn((url: URL) => {
      if (url.pathname.endsWith('getPublicConfig')) {
        return Promise.resolve(jsonResponse({ hostname: url.hostname, serviceUrl: url.origin }));
      }
      return Promise.resolve(jsonResponse({ communities: Array.from({ length: 100 }, (_, index) => community(index)) }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getCachedPeerCommunities } = await loadPeerCache(peers.join(','));

    const result = await getCachedPeerCommunities();
    expect(result.communities[0]).toMatchObject({ did: 'did:plc:community0' });
    expect(result.communities).toHaveLength(500);
  });
});
