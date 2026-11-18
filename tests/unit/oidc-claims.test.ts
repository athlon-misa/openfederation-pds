import { describe, expect, it } from 'vitest';
import { claimsFor, didSlug, parseScopes } from '../../src/oidc/claims.js';
import { presetConfiguration, presetRedirectUri } from '../../src/oidc/app-presets.js';

describe('didSlug (ADR-005, decision 5)', () => {
  it('is the DID without "did:", safe as a username and an email local part', () => {
    expect(didSlug('did:plc:svyqejp7a6te7uuouvt3leqb')).toBe('plc_svyqejp7a6te7uuouvt3leqb');
    expect(didSlug('did:web:example.com')).toBe('web_example_com');
    expect(didSlug('did:web:example.com%3A8080')).toBe('web_example_com_3A8080');
    // What Mastodon builds when there is no email: must be a valid address.
    expect(`change@me-${didSlug('did:plc:svyqejp7a6te7uuouvt3leqb')}-openid_connect.com`)
      .toMatch(/^[a-z]+@[a-z0-9._-]+\.com$/i);
  });
});

describe('claims', () => {
  const person = { did: 'did:plc:abc', handle: 'alice.example.net', displayName: 'Alice', email: 'a@example.net', emailVerified: true };

  it('sub is always the DID; profile adds handle, did_slug and name', () => {
    expect(claimsFor(person, ['openid'])).toEqual({ sub: 'did:plc:abc' });
    expect(claimsFor(person, ['openid', 'profile'])).toEqual({
      sub: 'did:plc:abc', did: 'did:plc:abc', did_slug: 'plc_abc',
      handle: 'alice.example.net', preferred_username: 'alice.example.net', name: 'Alice',
    });
  });

  it('email only with the email scope and only when known', () => {
    expect(claimsFor(person, ['openid', 'email'])).toMatchObject({ email: 'a@example.net', email_verified: true });
    expect(claimsFor({ ...person, email: null }, ['openid', 'email'])).not.toHaveProperty('email');
  });

  it('a name even without a handle', () => {
    expect(claimsFor({ ...person, handle: null, displayName: null }, ['openid', 'profile']).name).toBe('plc_abc');
  });

  it('parseScopes keeps supported scopes only', () => {
    expect(parseScopes('email openid offline_access profile')).toEqual(['openid', 'profile', 'email']);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe('app presets', () => {
  it('knows each app\'s redirect URI', () => {
    expect(presetRedirectUri('mastodon', 'https://m.example/some/path')).toBe('https://m.example/auth/auth/openid_connect/callback');
    expect(presetRedirectUri('lemmy', 'https://l.example')).toBe('https://l.example/oauth/callback');
    expect(presetRedirectUri('gotosocial', 'https://g.example')).toBe('https://g.example/auth/callback');
    expect(presetRedirectUri('generic', 'https://x.example')).toBeNull();
  });

  it('Mastodon uses did_slug as its uid and the issuer with discovery', () => {
    const text = presetConfiguration({
      preset: 'mastodon', appUrl: 'https://m.example', issuer: 'https://pds.example/oidc',
      clientId: 'm', clientSecret: 's3cret', displayName: 'Our Mastodon',
    });
    expect(text).toContain('OIDC_UID_FIELD=did_slug');
    expect(text).toContain('OIDC_ISSUER=https://pds.example/oidc');
    expect(text).toContain('OIDC_DISCOVERY=true');
    expect(text).toContain('OIDC_CLIENT_SECRET=s3cret');
    expect(text).toContain('OIDC_REDIRECT_URI=https://m.example/auth/auth/openid_connect/callback');
  });

  it('without the secret, a placeholder', () => {
    const text = presetConfiguration({
      preset: 'lemmy', appUrl: 'https://l.example', issuer: 'https://pds.example/oidc',
      clientId: 'l', clientSecret: null, displayName: 'L',
    });
    expect(text).toContain('<the client secret shown when it was created>');
  });
});
