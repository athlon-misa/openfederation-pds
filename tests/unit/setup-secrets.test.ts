/**
 * The secrets the setup wizard generates (#405) have the shapes the server
 * reads, and are new every time.
 */
import { describe, it, expect } from 'vitest';
import { generateSecrets } from '../../src/setup/secrets.js';
import { loadOAuthSigningKey } from '../../src/oauth/oauth-setup.js';
import { productionConfigProblems } from '../../src/server/production-checks.js';

describe('generateSecrets', () => {
  it('produces 256-bit hex secrets, an ES256 OAuth key the server loads, and a hex DPoP secret', async () => {
    const s = generateSecrets();
    expect(s.AUTH_JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(s.KEY_ENCRYPTION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(s.OAUTH_DPOP_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(s.OAUTH_DPOP_SECRET, 'hex')).toHaveLength(32);
    const jwk = JSON.parse(s.OAUTH_SIGNING_KEY);
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'oauth-signing-key' });
    expect(jwk.d).toBeTruthy();
    const key = await loadOAuthSigningKey(s.OAUTH_SIGNING_KEY);
    expect(key.isPrivate).toBe(true);
    expect(key.algorithms).toContain('ES256');
    expect(s.OAUTH_SIGNING_KEY).not.toContain('\n');
  });

  it('never repeats', () => {
    const a = generateSecrets();
    const b = generateSecrets();
    for (const k of Object.keys(a) as Array<keyof typeof a>) expect(a[k]).not.toBe(b[k]);
  });

  it('satisfies the production start-up checks', () => {
    const s = generateSecrets();
    const problems = productionConfigProblems({
      isProduction: true,
      oauth: { enabled: true, signingKey: s.OAUTH_SIGNING_KEY, redisUrl: '' },
      database: { ssl: false, host: 'postgres.railway.internal' },
    });
    expect(problems.fatal).toEqual([]);
  });
});
