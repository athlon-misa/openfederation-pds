import { describe, it, expect, beforeEach } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  signServiceAuthJwt, verifyServiceAuthJwt, _clearReplayCache, _resetServiceAuthRateLimiter,
} from '../../src/auth/service-auth.js';

const SERVICE_DID = 'did:web:pds.example.com';
const ISS = 'did:plc:test-issuer-abc';
const METHOD = 'com.atproto.repo.createRecord';

describe('service-auth hardening', () => {
  let keypair: Secp256k1Keypair;
  const verify = (token: string, extra: Record<string, unknown> = {}) => verifyServiceAuthJwt(token, {
    expectedAud: SERVICE_DID, expectedLxm: METHOD, resolveSigningKey: async () => keypair.did(), ...extra,
  });
  const mint = (over: { exp?: number; lxm?: string | null } = {}) => signServiceAuthJwt({
    keypair, iss: ISS, aud: SERVICE_DID,
    exp: over.exp ?? Math.floor(Date.now() / 1000) + 60,
    lxm: over.lxm === null ? undefined : (over.lxm ?? METHOD),
  });

  beforeEach(async () => {
    _clearReplayCache();
    _resetServiceAuthRateLimiter();
    keypair = await Secp256k1Keypair.create();
  });

  it('rejects a replay whose signature segment was re-encoded to look different', async () => {
    const token = await mint();
    await verify(token);
    const [h, p, sig] = token.split('.');
    // Same signature bytes, different text: lenient base64 decoding ignores the
    // stray characters, so a cache keyed on the text sees a "new" token.
    const reEncoded = `${h}.${p}.${sig.slice(0, 4)}!!!!${sig.slice(4)}`;
    await expect(verify(reEncoded)).rejects.toThrow(/already been used|did not verify|Malformed/i);
    const padded = `${h}.${p}.${sig}==`;
    await expect(verify(padded)).rejects.toThrow(/already been used|did not verify|Malformed/i);
  });

  it('rejects a token that names no method when the endpoint expects one', async () => {
    const token = await mint({ lxm: null });
    await expect(verify(token)).rejects.toThrow(/lxm/i);
  });

  it('rejects a token that is valid for longer than the maximum lifetime', async () => {
    const token = await mint({ exp: Math.floor(Date.now() / 1000) + 24 * 3600 });
    await expect(verify(token)).rejects.toThrow(/expire|lifetime/i);
  });

  it('still accepts an ordinary short-lived, method-scoped token', async () => {
    const claims = await verify(await mint());
    expect(claims.iss).toBe(ISS);
  });
});
