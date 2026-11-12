import { describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { parseFederationPeers, resolvePeerUrls, staticPeerSource } from '../../src/federation/peer-sources.js';
import { parsePeerDirectory, fetchPeerDirectory, MAX_ENTRIES_PER_PEER } from '../../src/federation/community-discovery.js';

const PEER = 'https://peer.example';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    did: 'did:plc:abcdefghijklmnopqrstuvwx',
    handle: 'chess.peer.example',
    displayName: 'Chess Club',
    description: 'We play chess',
    memberCount: 4,
    pdsUrl: PEER,
    ...overrides,
  };
}

describe('parseFederationPeers', () => {
  it('returns an empty list when unset', () => {
    expect(parseFederationPeers('', { isProduction: true, selfUrl: 'https://me.example' })).toEqual([]);
    expect(parseFederationPeers(undefined, { isProduction: true, selfUrl: 'https://me.example' })).toEqual([]);
  });

  it('normalises to origins, removes duplicates and this PDS', () => {
    const peers = parseFederationPeers(
      ' https://a.example/ , https://B.example/some/path,https://a.example,https://me.example/',
      { isProduction: true, selfUrl: 'https://me.example' },
    );
    expect(peers).toEqual(['https://a.example', 'https://b.example']);
  });

  it('refuses http peers in production and allows them in development', () => {
    expect(() => parseFederationPeers('http://a.example', { isProduction: true, selfUrl: '' }))
      .toThrow(/FEDERATION_PEERS/);
    expect(parseFederationPeers('http://127.0.0.1:9999', { isProduction: false, selfUrl: '' }))
      .toEqual(['http://127.0.0.1:9999']);
  });

  it('refuses values that are not URLs, carry credentials, or use other schemes', () => {
    for (const bad of ['not a url', 'ftp://a.example', 'https://user:pw@a.example']) {
      expect(() => parseFederationPeers(bad, { isProduction: false, selfUrl: '' })).toThrow(/FEDERATION_PEERS/);
    }
  });
});

describe('resolvePeerUrls', () => {
  it('merges sources in order, once each, without this PDS, and survives a failing source', async () => {
    const broken = { name: 'broken', listPeers: async () => { throw new Error('down'); } };
    const urls = await resolvePeerUrls([
      staticPeerSource('config', () => ['https://a.example', 'https://me.example']),
      broken,
      // e.g. a future central directory naming an overlapping set
      staticPeerSource('directory', () => ['https://b.example/', 'https://a.example/']),
    ], 'https://me.example');
    expect(urls).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('parsePeerDirectory (peer data is untrusted)', () => {
  it('accepts a well-formed document and stamps the peer it came from', () => {
    const parsed = parsePeerDirectory({ version: 1, communities: [entry({ pdsUrl: 'https://elsewhere.example' })] }, PEER);
    expect(parsed).toEqual([{
      did: 'did:plc:abcdefghijklmnopqrstuvwx',
      handle: 'chess.peer.example',
      displayName: 'Chess Club',
      description: 'We play chess',
      memberCount: 4,
      pdsUrl: PEER,
    }]);
  });

  it('rejects documents of the wrong shape', () => {
    for (const bad of [null, 'text', [], {}, { version: 'one', communities: [] }, { version: 1, communities: {} }, { version: 0, communities: [] }]) {
      expect(() => parsePeerDirectory(bad, PEER)).toThrow();
    }
  });

  it('drops malformed entries and entries a peer marks as not public', () => {
    const parsed = parsePeerDirectory({
      version: 1,
      communities: [
        entry({ did: 'not-a-did' }),
        entry({ did: 42 }),
        entry({ did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', handle: '<script>' }),
        entry({ did: 'did:plc:cccccccccccccccccccccccc', visibility: 'private' }),
        entry({ did: 'did:plc:dddddddddddddddddddddddd', memberCount: 'lots' }),
        'garbage',
        entry({ did: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee' }),
      ],
    }, PEER);
    expect(parsed.map((c) => c.did)).toEqual(['did:plc:eeeeeeeeeeeeeeeeeeeeeeee']);
  });

  it('truncates long text and falls back to the handle for a missing name', () => {
    const [c] = parsePeerDirectory({
      version: 1,
      communities: [entry({ displayName: undefined, description: 'x'.repeat(5000) })],
    }, PEER);
    expect(c.displayName).toBe('chess.peer.example');
    expect(c.description.length).toBeLessThanOrEqual(300);
  });

  it('in production, refuses plain http and internal addresses before fetching', async () => {
    const saved = config.env.isProduction;
    config.env.isProduction = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const url of ['http://peer.example', 'https://127.0.0.1', 'https://10.0.0.5', 'https://[::1]', 'https://localhost']) {
        await expect(fetchPeerDirectory(url, 1000)).resolves.toEqual({ url, status: 'failed', error: 'BlockedUrl' });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      config.env.isProduction = saved;
      fetchSpy.mockRestore();
    }
  });

  it('keeps at most MAX_ENTRIES_PER_PEER entries', () => {
    const many = Array.from({ length: MAX_ENTRIES_PER_PEER + 50 }, (_, i) =>
      entry({ did: `did:web:c${i}.peer.example`, handle: `c${i}.peer.example` }));
    expect(parsePeerDirectory({ version: 1, communities: many }, PEER)).toHaveLength(MAX_ENTRIES_PER_PEER);
  });
});
