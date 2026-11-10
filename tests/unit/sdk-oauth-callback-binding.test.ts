/**
 * The SDK's "Sign in with ATProto" flow is bound to the tab that started it.
 * Without that, anyone can finish a login as themselves, keep the one-time
 * code, and send a victim a callback link that signs the victim in as them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { challengeFromSdkLogin, deriveChallenge } from '../../src/oauth/external-routes.js';
import { createClient } from '../../packages/openfederation-sdk/src/index.js';

describe('server: challenge supplied on the SDK login redirect', () => {
  it('accepts a well-formed S256 challenge', () => {
    const challenge = deriveChallenge(crypto.randomBytes(32).toString('base64url'));
    expect(challengeFromSdkLogin(challenge)).toBe(challenge);
  });

  it('ignores anything that is not one', () => {
    for (const bad of [undefined, '', 'short', 'x'.repeat(200), 'has spaces and = signs====', ['a']]) {
      expect(challengeFromSdkLogin(bad as never)).toBeNull();
    }
  });
});

describe('SDK: handleOAuthCallback', () => {
  const store = new Map<string, string>();
  let location: { href: string; search: string };

  beforeEach(() => {
    store.clear();
    location = { href: 'https://app.example/callback', search: '' };
    vi.stubGlobal('window', { location });
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const client = () => createClient({ serverUrl: 'https://pds.example', partnerKey: 'ofp_test', storage: 'memory' });

  it('refuses a callback code when this tab did not start a login', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    location.search = '?code=attackers-code';
    await expect(client().handleOAuthCallback()).rejects.toThrow(/not started/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the challenge when starting, and the matching verifier when finishing', async () => {
    const sdk = client();
    sdk.loginWithATProto({ handle: 'alice.example.com', redirectUri: 'https://app.example/callback' });
    const started = new URL(location.href);
    const challenge = started.searchParams.get('code_challenge');
    expect(started.pathname).toBe('/auth/atproto');
    expect(challenge).toBeTruthy();

    let sentBody: { code?: string; codeVerifier?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return new Response(JSON.stringify({
        did: 'did:plc:abc', handle: 'alice.example.com', email: '', accessJwt: 'a.b.c', refreshJwt: 'r',
      }), { status: 200 });
    }));
    location.search = '?code=the-code';
    const user = await sdk.handleOAuthCallback();
    expect(user.did).toBe('did:plc:abc');
    expect(sentBody.code).toBe('the-code');
    expect(deriveChallenge(sentBody.codeVerifier ?? '')).toBe(challenge);

    // The verifier is single-use: the same callback cannot be replayed in this tab.
    await expect(sdk.handleOAuthCallback()).rejects.toThrow(/not started/i);
  });
});
