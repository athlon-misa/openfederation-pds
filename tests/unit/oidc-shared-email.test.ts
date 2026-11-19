/**
 * Reading the email another server shared for an OpenID Connect sign-in
 * (#461): com.atproto.server.getSession once, then the session is revoked.
 */
import { describe, it, expect } from 'vitest';
import { readSharedEmail } from '../../src/oauth/external-routes.js';
import { parseTrustedEmailIssuers } from '../../src/oidc/claims.js';
import { SIGNIN_SCOPE, SIGNIN_SCOPE_WITH_EMAIL, getClientMetadata } from '../../src/oauth/external-client.js';

function fakeSession(answer: () => Promise<Response>, issuer = 'https://bsky.social') {
  const calls: string[] = [];
  let signedOut = 0;
  return {
    calls,
    serverMetadata: { issuer },
    get signedOut() { return signedOut; },
    async fetchHandler(path: string) { calls.push(path); return answer(); },
    async signOut() { signedOut++; },
  };
}

const json = (body: unknown, status = 200) =>
  async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('readSharedEmail', () => {
  it('returns the address and whether the server confirmed it, then revokes the session', async () => {
    const s = fakeSession(json({ did: 'did:plc:x', handle: 'x.bsky.social', email: ' Reader@Example.com ', emailConfirmed: true }));
    expect(await readSharedEmail(s)).toEqual({ email: 'reader@example.com', emailVerified: true });
    expect(s.calls).toEqual(['/xrpc/com.atproto.server.getSession']);
    expect(s.signedOut).toBe(1);
  });

  it('a server not on the trusted list is never believed: its address arrives unverified', async () => {
    // Anyone can run a server that says any address is confirmed.
    const s = fakeSession(json({ email: 'misa@example.com', emailConfirmed: true }), 'https://pds.attacker.example');
    expect(await readSharedEmail(s, ['https://bsky.social'])).toEqual({ email: 'misa@example.com', emailVerified: false });
    const none = fakeSession(json({ email: 'a@example.com', emailConfirmed: true }));
    expect(await readSharedEmail(none, [])).toEqual({ email: 'a@example.com', emailVerified: false });
  });

  it('an unconfirmed address is reported as unverified', async () => {
    const s = fakeSession(json({ email: 'new@example.com' }));
    expect(await readSharedEmail(s)).toEqual({ email: 'new@example.com', emailVerified: false });
  });

  it('no email (the person did not share it) or a failure gives null, and still revokes', async () => {
    for (const answer of [json({ did: 'did:plc:x' }), json({ error: 'x' }, 401), async () => { throw new Error('down'); }]) {
      const s = fakeSession(answer);
      expect(await readSharedEmail(s)).toBeNull();
      expect(s.signedOut).toBe(1);
    }
  });
});

describe('scopes', () => {
  it('plain sign-in asks for the account only; the metadata allows the email scope too', () => {
    expect(SIGNIN_SCOPE.split(' ')).not.toContain('transition:email');
    expect(SIGNIN_SCOPE_WITH_EMAIL.split(' ')).toContain('transition:email');
    expect(getClientMetadata().scope).toBe(SIGNIN_SCOPE_WITH_EMAIL);
  });
});

describe('parseTrustedEmailIssuers', () => {
  it('defaults to Bluesky; none means no server', () => {
    expect(parseTrustedEmailIssuers(undefined)).toEqual(['https://bsky.social']);
    expect(parseTrustedEmailIssuers(' ')).toEqual(['https://bsky.social']);
    expect(parseTrustedEmailIssuers('none')).toEqual([]);
  });

  it('takes https origins only', () => {
    expect(parseTrustedEmailIssuers('https://bsky.social/, https://pds.example.org'))
      .toEqual(['https://bsky.social', 'https://pds.example.org']);
    expect(() => parseTrustedEmailIssuers('http://pds.example.org')).toThrow(/https/);
    expect(() => parseTrustedEmailIssuers('https://pds.example.org/oauth')).toThrow(/origin/);
    expect(() => parseTrustedEmailIssuers('bsky.social')).toThrow(/not a URL/);
  });
});

describe('parseSessionDays (#462)', () => {
  it('defaults to 7 days; 0 turns remembered sign-in off; at most 90', async () => {
    const { parseSessionDays } = await import('../../src/oidc/claims.js');
    expect(parseSessionDays(undefined)).toBe(7);
    expect(parseSessionDays('0')).toBe(0);
    expect(parseSessionDays('30')).toBe(30);
    for (const bad of ['91', '-1', '1.5', 'week', '007']) expect(() => parseSessionDays(bad)).toThrow(/OIDC_SESSION_DAYS/);
  });
});
