import { describe, expect, it } from 'vitest';
import { oauthCredentialLimiterFor } from '../../src/oauth/oauth-routes.js';

describe('rate limits on the OAuth provider credential endpoints', () => {
  const api = '/@atproto/oauth-provider/~api';

  it('applies the login limit to password sign-in', () => {
    expect(oauthCredentialLimiterFor('POST', `${api}/sign-in`)).toBe('auth');
  });

  it('applies the registration limit to sign-up', () => {
    expect(oauthCredentialLimiterFor('POST', `${api}/sign-up`)).toBe('registration');
  });

  it('applies the login limit to the password-reset endpoints', () => {
    expect(oauthCredentialLimiterFor('POST', `${api}/reset-password-request`)).toBe('auth');
    expect(oauthCredentialLimiterFor('POST', `${api}/reset-password-confirm`)).toBe('auth');
  });

  it('leaves everything else to the global limit', () => {
    expect(oauthCredentialLimiterFor('GET', '/oauth/authorize')).toBeNull();
    expect(oauthCredentialLimiterFor('POST', '/oauth/token')).toBeNull();
    expect(oauthCredentialLimiterFor('GET', `${api}/sign-in`)).toBeNull();
  });
});
