/**
 * OAUTH_SIGNING_KEY keys made with a `"use": "sig"` member load without the
 * library's "Private JWK with a use property will be rejected in the future"
 * warning, and are the same key: tokens they signed before still verify.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { loadOAuthSigningKey } from '../../src/oauth/oauth-setup.js';

function jwk(extra: Record<string, unknown> = {}): string {
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  return JSON.stringify({ ...k, alg: 'ES256', kid: 'oauth-signing-key', ...extra });
}

describe('loadOAuthSigningKey', () => {
  it('loads a key that carries "use": "sig" without the deprecation warning', async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { warnings.push(a.join(' ')); });
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(((w: unknown) => { warnings.push(String(w)); }) as never);
    try {
      const key = await loadOAuthSigningKey(jwk({ use: 'sig' }));
      expect(key.isPrivate).toBe(true);
      expect(key.algorithms).toContain('ES256');
    } finally {
      warn.mockRestore();
      emit.mockRestore();
    }
    expect(warnings.join('\n')).not.toMatch(/use.*property/i);
  });

  it('is the same key: what it signed with "use" still verifies after loading', async () => {
    const raw = jwk({ use: 'sig' });
    const key = await loadOAuthSigningKey(raw);
    expect(key.kid).toBe('oauth-signing-key');
    const pub = JSON.parse(raw);
    expect(key.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y });
  });

  it('loads a key without "use" unchanged', async () => {
    const key = await loadOAuthSigningKey(jwk());
    expect(key.isPrivate).toBe(true);
  });
});
