/**
 * Login handoff codes are bound to the browser that started the flow (#146).
 *
 * The attack: complete external OAuth as yourself, withhold the 60-second
 * handoff code, send /callback?code=... to a victim. Their browser exchanges it
 * and is silently signed in as you — login CSRF / session swapping.
 *
 * The binding is PKCE-shaped: the browser keeps a random verifier and sends only
 * its SHA-256, which rides in the OAuth `state` and is attached to the handoff
 * code at the callback. Redemption requires the verifier, which the victim's
 * browser does not have.
 *
 * These cover the pure logic — digest, comparison, state parsing. The
 * end-to-end redemption path is exercised in the API suite.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  readCodeChallenge,
  deriveChallenge,
  safeEqual,
} from '../../src/oauth/external-routes.js';

const verifier = () => crypto.randomBytes(32).toString('base64url');

describe('deriveChallenge', () => {
  it('is the base64url SHA-256 of the verifier (RFC 7636 S256 shape)', () => {
    const v = 'a-known-verifier';
    const expected = crypto.createHash('sha256').update(v).digest('base64url');
    expect(deriveChallenge(v)).toBe(expected);
    expect(deriveChallenge(v)).not.toContain('=');
    expect(deriveChallenge(v)).not.toContain('+');
    expect(deriveChallenge(v)).not.toContain('/');
  });

  it('is deterministic and differs per verifier', () => {
    const a = verifier();
    const b = verifier();
    expect(deriveChallenge(a)).toBe(deriveChallenge(a));
    expect(deriveChallenge(a)).not.toBe(deriveChallenge(b));
  });

  it('does not reveal the verifier', () => {
    const v = verifier();
    expect(deriveChallenge(v)).not.toContain(v);
  });
});

describe('safeEqual', () => {
  it('matches identical digests', () => {
    const d = deriveChallenge(verifier());
    expect(safeEqual(d, d)).toBe(true);
  });

  it('rejects a different digest', () => {
    expect(safeEqual(deriveChallenge('a'), deriveChallenge('b'))).toBe(false);
  });

  it('rejects on length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths; the guard must absorb that.
    expect(safeEqual('short', deriveChallenge('x'))).toBe(false);
    expect(safeEqual('', deriveChallenge('x'))).toBe(false);
  });

  it('rejects a prefix of the correct digest', () => {
    const d = deriveChallenge('x');
    expect(safeEqual(d.slice(0, -1), d)).toBe(false);
  });
});

describe('readCodeChallenge', () => {
  it('extracts a challenge from our own state', () => {
    const c = deriveChallenge(verifier());
    expect(readCodeChallenge(JSON.stringify({ codeChallenge: c }))).toBe(c);
  });

  it('returns null for absent state', () => {
    expect(readCodeChallenge(null)).toBeNull();
    expect(readCodeChallenge(undefined)).toBeNull();
    expect(readCodeChallenge('')).toBeNull();
  });

  it('returns null for state that is not ours', () => {
    // SDK consumers pass their own opaque state through the same parameter.
    expect(readCodeChallenge('some-consumer-state')).toBeNull();
    expect(readCodeChallenge(JSON.stringify({ nonce: 'x' }))).toBeNull();
  });

  it('ignores a non-string challenge', () => {
    expect(readCodeChallenge(JSON.stringify({ codeChallenge: 42 }))).toBeNull();
    expect(readCodeChallenge(JSON.stringify({ codeChallenge: { a: 1 } }))).toBeNull();
    expect(readCodeChallenge(JSON.stringify({ codeChallenge: '' }))).toBeNull();
  });
});

describe('the attack, in terms of the primitives', () => {
  it("a victim's browser cannot derive the attacker's challenge", () => {
    // Attacker starts the flow; the PDS binds their challenge to the code.
    const attackerVerifier = verifier();
    const boundChallenge = deriveChallenge(attackerVerifier);

    // The victim receives only the code. Their tab holds a different verifier
    // (or none), so redemption fails.
    const victimVerifier = verifier();
    expect(safeEqual(deriveChallenge(victimVerifier), boundChallenge)).toBe(false);

    // And only the attacker's own verifier would work — which they never send.
    expect(safeEqual(deriveChallenge(attackerVerifier), boundChallenge)).toBe(true);
  });
});
