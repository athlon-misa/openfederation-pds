/**
 * SDK client: discovering communities across servers (#41) and the user's
 * activity timeline (#42), against a fake fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenFederationClient } from '../../packages/openfederation-sdk/src/client.js';
import { TokenManager } from '../../packages/openfederation-sdk/src/auth.js';
import { AuthenticationError, ValidationError } from '../../packages/openfederation-sdk/src/errors.js';

const SERVER = 'https://pds.example';
const user = { did: 'did:plc:viewer', handle: 'viewer.example', email: '', active: true };

function jwt(expInSec: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expInSec })}.sig`;
}

type Call = { url: URL; init?: RequestInit };

function fakeFetch(respond: (url: URL) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return respond(url);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function client(signedIn: boolean): OpenFederationClient {
  const c = new OpenFederationClient({ serverUrl: `${SERVER}/`, partnerKey: 'pk', storage: 'memory', autoRefresh: false });
  if (signedIn) {
    // The client's token manager, as login() would have filled it.
    const tokens = (c as unknown as { tokens: TokenManager }).tokens;
    tokens.setTokens(jwt(900), 'refresh-0', user);
  }
  return c;
}

const discovered = {
  communities: [
    { did: 'did:plc:here', handle: 'here.example', displayName: 'Here', description: '', memberCount: 3, pdsUrl: SERVER, source: 'local' },
    { did: 'did:plc:there', handle: 'there.peer', displayName: 'There', description: 'x', memberCount: 9, pdsUrl: 'https://peer.example', source: 'peer' },
  ],
  cursor: '50',
  peers: [
    { url: 'https://peer.example', status: 'ok', communityCount: 1 },
    { url: 'https://down.example', status: 'failed', error: 'Timeout' },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SDK discoverCommunities', () => {
  it('calls community.discover without a session and returns communities, cursor and peers', async () => {
    const calls = fakeFetch(() => Response.json(discovered));
    const result = await client(false).discoverCommunities();

    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(`${SERVER}/xrpc/net.openfederation.community.discover`);
    expect(calls[0].url.search).toBe('');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBeNull();
    expect(result).toEqual(discovered);
    expect(result.communities[1].source).toBe('peer');
    expect(result.peers[1]).toEqual({ url: 'https://down.example', status: 'failed', error: 'Timeout' });
  });

  it('passes limit, cursor and q', async () => {
    const calls = fakeFetch(() => Response.json({ communities: [], peers: [] }));
    await client(false).discoverCommunities({ limit: 10, cursor: '50', q: 'chess' });

    const params = calls[0].url.searchParams;
    expect(params.get('limit')).toBe('10');
    expect(params.get('cursor')).toBe('50');
    expect(params.get('q')).toBe('chess');
  });

  it('omits empty options', async () => {
    const calls = fakeFetch(() => Response.json({ communities: [], peers: [] }));
    await client(false).discoverCommunities({ cursor: '', q: '' });
    expect(calls[0].url.search).toBe('');
  });

  it('throws the typed error the server answered with', async () => {
    fakeFetch(() => Response.json({ error: 'InvalidRequest', message: 'Invalid cursor' }, { status: 400 }));
    const err = await client(false).discoverCommunities({ cursor: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Invalid cursor');
  });
});

describe('SDK getUserTimeline', () => {
  const timeline = {
    entries: [
      {
        id: 'at://did:plc:here/net.openfederation.community.member/abc',
        kind: 'member.joined',
        community: 'did:plc:here',
        actor: 'did:plc:alice',
        uri: 'at://did:plc:here/net.openfederation.community.member/abc',
        createdAt: '2026-11-01T10:00:00.000000Z',
        summary: { handle: 'alice.example', role: 'member' },
      },
    ],
    cursor: 'MjAyNi0xMS0wMVQxMDowMDowMC4wMDAwMDBafGFiYw',
    unreachable: ['did:plc:far'],
    unreachablePeers: ['https://down.example'],
  };

  it('calls activity.getUserTimeline with the session token', async () => {
    const calls = fakeFetch(() => Response.json(timeline));
    const result = await client(true).getUserTimeline({ limit: 20, cursor: 'abc' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/xrpc/net.openfederation.activity.getUserTimeline');
    expect(calls[0].url.searchParams.get('limit')).toBe('20');
    expect(calls[0].url.searchParams.get('cursor')).toBe('abc');
    expect(calls[0].init?.method).toBe('GET');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    expect(result).toEqual(timeline);
  });

  it('sends no parameters when none are given', async () => {
    const calls = fakeFetch(() => Response.json({ entries: [], unreachable: [], unreachablePeers: [] }));
    const result = await client(true).getUserTimeline();
    expect(calls[0].url.search).toBe('');
    expect(result.entries).toEqual([]);
    expect(result.cursor).toBeUndefined();
  });

  it('refuses without a session, before any request', async () => {
    const calls = fakeFetch(() => Response.json({}));
    await expect(client(false).getUserTimeline()).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(0);
  });

  it('throws the typed error the server answered with', async () => {
    fakeFetch(() => Response.json({ error: 'InvalidRequest', message: 'cursor is not valid' }, { status: 400 }));
    const err = await client(true).getUserTimeline({ cursor: 'bogus' }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
  });
});
