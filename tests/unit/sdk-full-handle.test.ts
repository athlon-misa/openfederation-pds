/**
 * SDK: the user's handle is the server's full handle (#411). A current server
 * returns it in full and the SDK asks nothing more; an older one answers with
 * the name only, which the SDK completes with the server's handle domain.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenFederationClient } from '../../packages/openfederation-sdk/src/client.js';
import { displayHandle, fullHandle } from '../../packages/openfederation-sdk/src/utils.js';

const SERVER = 'https://pds.example';

function jwt(expInSec: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expInSec })}.sig`;
}

function fakeServer(sessionHandle: string) {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith('/com.atproto.server.describeServer')) {
      return Response.json({ did: 'did:web:pds.example', availableUserDomains: ['.news.example'] });
    }
    return Response.json({ did: 'did:plc:elena', handle: sessionHandle, email: 'e@x', accessJwt: jwt(900), refreshJwt: 'r1', active: true });
  }));
  return paths;
}

const client = () => new OpenFederationClient({ serverUrl: SERVER, partnerKey: 'pk', storage: 'memory', autoRefresh: false });

afterEach(() => vi.unstubAllGlobals());

describe('SDK handles (#411)', () => {
  it('keeps a full handle from the server as it is, without asking for the domain', async () => {
    const paths = fakeServer('elena.news.example');
    const user = await client().login({ identifier: 'elena', password: 'pw' });
    expect(user.handle).toBe('elena.news.example');
    expect(paths.some((p) => p.endsWith('describeServer'))).toBe(false);
  });

  it('completes a short handle from an older server with its handle domain', async () => {
    fakeServer('elena');
    const c = client();
    const user = await c.login({ identifier: 'elena', password: 'pw' });
    expect(user.handle).toBe('elena.news.example');
    expect((await c.getUser())?.handle).toBe('elena.news.example');
    // ...and shows the name without that server's domain.
    expect(c.displayHandle(user.handle)).toBe('elena');
  });

  it('fullHandle leaves DIDs, foreign handles and external placeholders alone', () => {
    expect(fullHandle('elena', '.news.example')).toBe('elena.news.example');
    expect(fullHandle('elena', 'news.example')).toBe('elena.news.example');
    expect(fullHandle('alice.bsky.social', '.news.example')).toBe('alice.bsky.social');
    expect(fullHandle('did:plc:abc', '.news.example')).toBe('did:plc:abc');
    expect(fullHandle('plc-abcdefghijklmnopqrstuvwx', '.news.example')).toBe('plc-abcdefghijklmnopqrstuvwx');
    expect(fullHandle('elena')).toBe('elena');
    expect(displayHandle('elena.openfederation.net')).toBe('elena');
  });
});
