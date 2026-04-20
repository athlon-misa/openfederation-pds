import { describe, it, expect, beforeEach } from 'vitest';
import { Secp256k1Keypair, P256Keypair } from '@atproto/crypto';
import {
  signServiceAuthJwt,
  verifyServiceAuthJwt,
  looksLikeServiceAuthJwt,
  ServiceAuthError,
  checkServiceAuthRateLimit,
  _clearReplayCache,
  _resetServiceAuthRateLimiter,
} from '../../src/auth/service-auth.js';

const SERVICE_DID = 'did:web:pds.example.com';

// A test "iss" DID with a known signing key. In unit tests we bypass PLC
// resolution via opts.resolveSigningKey.
const ISS_DID = 'did:plc:test-issuer-abc';

async function makeValidJwt(
  keypair: Secp256k1Keypair | P256Keypair,
  overrides: Partial<{
    iss: string;
    aud: string;
    exp: number;
    iat: number;
    nbf: number;
    lxm: string;
  }> = {}
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return signServiceAuthJwt({
    keypair,
    iss: overrides.iss ?? ISS_DID,
    aud: overrides.aud ?? SERVICE_DID,
    exp: overrides.exp ?? nowSec + 60,
    lxm: overrides.lxm,
  });
}

describe('service-auth JWT', () => {
  beforeEach(() => {
    _clearReplayCache();
    _resetServiceAuthRateLimiter();
  });

  it('looksLikeServiceAuthJwt returns true for ES256K/ES256, false for HS256 and garbage', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp);
    expect(looksLikeServiceAuthJwt(jwt)).toBe(true);

    // HS256 token (emulate a local session JWT header)
    const hs = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    expect(looksLikeServiceAuthJwt(`${hs}.${body}.sig`)).toBe(false);

    expect(looksLikeServiceAuthJwt('not-a-jwt')).toBe(false);
    expect(looksLikeServiceAuthJwt('a.b')).toBe(false);
  });

  it('accepts a valid secp256k1-signed token with matching aud', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp);
    const claims = await verifyServiceAuthJwt(jwt, {
      expectedAud: SERVICE_DID,
      resolveSigningKey: async () => kp.did(),
    });
    expect(claims.iss).toBe(ISS_DID);
    expect(claims.aud).toBe(SERVICE_DID);
  });

  it('accepts a valid P-256 (ES256) signed token', async () => {
    const kp = await P256Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp);
    const claims = await verifyServiceAuthJwt(jwt, {
      expectedAud: SERVICE_DID,
      resolveSigningKey: async () => kp.did(),
    });
    expect(claims.iss).toBe(ISS_DID);
  });

  it('rejects a token with wrong audience (BadAudience)', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp, { aud: 'did:web:wrong-service.example.com' });
    await expect(
      verifyServiceAuthJwt(jwt, {
        expectedAud: SERVICE_DID,
        resolveSigningKey: async () => kp.did(),
      })
    ).rejects.toMatchObject({ code: 'BadAudience' });
  });

  it('rejects an expired token (ExpiredToken)', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp, {
      exp: Math.floor(Date.now() / 1000) - 120, // 2 min in the past
    });
    await expect(
      verifyServiceAuthJwt(jwt, {
        expectedAud: SERVICE_DID,
        resolveSigningKey: async () => kp.did(),
      })
    ).rejects.toMatchObject({ code: 'ExpiredToken' });
  });

  it('rejects a tampered payload (InvalidSignature)', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp);
    const parts = jwt.split('.');
    // Re-encode payload with a different aud while keeping original signature
    const tampered = JSON.stringify({
      iss: ISS_DID,
      aud: SERVICE_DID,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const tamperedB64 = Buffer.from(tampered).toString('base64url');
    const badJwt = `${parts[0]}.${tamperedB64}.${parts[2]}`;
    await expect(
      verifyServiceAuthJwt(badJwt, {
        expectedAud: SERVICE_DID,
        resolveSigningKey: async () => kp.did(),
      })
    ).rejects.toMatchObject({ code: 'InvalidSignature' });
  });

  it('rejects replay of a previously-accepted token (ReplayedToken)', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp);
    // First use: accepted.
    await verifyServiceAuthJwt(jwt, {
      expectedAud: SERVICE_DID,
      resolveSigningKey: async () => kp.did(),
    });
    // Second use: rejected.
    await expect(
      verifyServiceAuthJwt(jwt, {
        expectedAud: SERVICE_DID,
        resolveSigningKey: async () => kp.did(),
      })
    ).rejects.toMatchObject({ code: 'ReplayedToken' });
  });

  it('rejects a token with mismatched lxm (BadLexiconMethod)', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp, { lxm: 'net.openfederation.community.join' });
    await expect(
      verifyServiceAuthJwt(jwt, {
        expectedAud: SERVICE_DID,
        expectedLxm: 'net.openfederation.community.leave',
        resolveSigningKey: async () => kp.did(),
      })
    ).rejects.toMatchObject({ code: 'BadLexiconMethod' });
  });

  it('rejects a token where resolution fails (IssuerResolutionFailed)', async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const jwt = await makeValidJwt(kp);
    await expect(
      verifyServiceAuthJwt(jwt, {
        expectedAud: SERVICE_DID,
        resolveSigningKey: async () => { throw new Error('unknown did'); },
      })
    ).rejects.toMatchObject({ code: 'IssuerResolutionFailed' });
  });

  it('rejects malformed JWTs with InvalidToken', async () => {
    await expect(
      verifyServiceAuthJwt('not.enough', { expectedAud: SERVICE_DID })
    ).rejects.toBeInstanceOf(ServiceAuthError);

    await expect(
      verifyServiceAuthJwt('a.b.c', { expectedAud: SERVICE_DID })
    ).rejects.toMatchObject({ code: 'InvalidToken' });
  });
});

describe('service-auth rate limiter', () => {
  beforeEach(() => {
    _resetServiceAuthRateLimiter();
  });

  it('allows calls under the limit and rejects once exceeded', () => {
    const did = 'did:plc:rate-test';
    const limit = 3;
    expect(checkServiceAuthRateLimit(did, limit)).toBe(true);
    expect(checkServiceAuthRateLimit(did, limit)).toBe(true);
    expect(checkServiceAuthRateLimit(did, limit)).toBe(true);
    expect(checkServiceAuthRateLimit(did, limit)).toBe(false);
  });

  it('tracks per-DID independently', () => {
    const a = 'did:plc:a';
    const b = 'did:plc:b';
    expect(checkServiceAuthRateLimit(a, 1)).toBe(true);
    expect(checkServiceAuthRateLimit(a, 1)).toBe(false);
    expect(checkServiceAuthRateLimit(b, 1)).toBe(true);
  });
});
