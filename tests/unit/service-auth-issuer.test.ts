import { describe, expect, it, vi } from 'vitest';
import { getServiceDid, verifyServiceAuthJwt } from '../../src/auth/service-auth.js';

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256K' })).toString('base64url');
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.invalid`;
}

describe('service-auth issuer resolution', () => {
  it('rejects an untrusted did:web issuer before key resolution', async () => {
    const resolveSigningKey = vi.fn();
    const token = unsignedJwt({
      iss: 'did:web:127.0.0.1:8443',
      aud: getServiceDid(),
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    await expect(verifyServiceAuthJwt(token, { resolveSigningKey }))
      .rejects.toMatchObject({ code: 'IssuerResolutionFailed' });
    expect(resolveSigningKey).not.toHaveBeenCalled();
  });
});
