import { describe, it, expect } from 'vitest';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { blindTokens, finalizeTokens, importTokenPublicKey } from '../../packages/openfederation-pseudonym/src/tokens.js';
import { base64UrlDecode, base64UrlEncode } from '../../packages/openfederation-pseudonym/src/formats.js';

const suite = RSABSSA.SHA384.PSS.Randomized();
async function serverKey() {
  const { publicKey, privateKey } = await suite.generateKey({ modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]) });
  const spki = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));
  return { privateKey, spki };
}

describe('blind creation tokens', () => {
  it('round-trips: blind, server signs blind, finalize verifies', async () => {
    const { privateKey, spki } = await serverKey();
    const pub = await importTokenPublicKey(spki);
    const pending = await blindTokens(pub, '2026-10', 3);
    const sigs = await Promise.all(pending.blinded.map(async (b) => base64UrlEncode(await suite.blindSign(privateKey, base64UrlDecode(b)))));
    const tokens = await finalizeTokens(pub, pending, sigs);
    expect(tokens).toHaveLength(3);
    for (const t of tokens) expect(await suite.verify(pub, base64UrlDecode(t.signature), base64UrlDecode(t.prepared))).toBe(true);
    expect(new Set(tokens.map((t) => t.prepared)).size).toBe(3);
  });

  it('detects a server that signs with a different key than it published', async () => {
    const published = await serverKey();
    const secret = await serverKey();
    const pub = await importTokenPublicKey(published.spki);
    const pending = await blindTokens(pub, '2026-10', 1);
    const sig = base64UrlEncode(await suite.blindSign(secret.privateKey, base64UrlDecode(pending.blinded[0])));
    await expect(finalizeTokens(pub, pending, [sig])).rejects.toThrow('KeyMismatch');
  });
});
