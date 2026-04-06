import { describe, it, expect } from 'vitest';
import { splitSecret, combineShares } from '../../src/vault/shamir.js';

describe('Shamir Secret Sharing', () => {
  it('should split a secret into the requested number of shares', () => {
    const secret = Buffer.from('a]3fGH!Kp@secure-rotation-key-bytes-1234');
    const shares = splitSecret(secret, 3, 2);
    expect(shares).toHaveLength(3);
    // Each share should be a non-empty hex string
    for (const share of shares) {
      expect(typeof share).toBe('string');
      expect(share.length).toBeGreaterThan(0);
    }
  });

  it('should reconstruct the secret from any 2 of 3 shares (threshold = 2)', () => {
    const secret = Buffer.from('my-rotation-key-bytes-for-threshold-test');
    const shares = splitSecret(secret, 3, 2);

    // Combination: shares 0 + 1
    const recovered01 = combineShares([shares[0], shares[1]]);
    expect(recovered01.equals(secret)).toBe(true);

    // Combination: shares 0 + 2
    const recovered02 = combineShares([shares[0], shares[2]]);
    expect(recovered02.equals(secret)).toBe(true);

    // Combination: shares 1 + 2
    const recovered12 = combineShares([shares[1], shares[2]]);
    expect(recovered12.equals(secret)).toBe(true);
  });

  it('should NOT reconstruct the original from a single share alone', () => {
    const secret = Buffer.from('cannot-recover-with-one-share');
    const shares = splitSecret(secret, 3, 2);

    // A single share combined alone should not produce the original secret
    const attemptedRecovery = combineShares([shares[0]]);
    expect(attemptedRecovery.equals(secret)).toBe(false);
  });

  it('should reconstruct from all 3 shares', () => {
    const secret = Buffer.from('all-three-shares-test');
    const shares = splitSecret(secret, 3, 2);

    const recovered = combineShares(shares);
    expect(recovered.equals(secret)).toBe(true);
  });

  it('should handle binary data (random bytes)', () => {
    const secret = Buffer.from([0x00, 0xff, 0x42, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89]);
    const shares = splitSecret(secret, 5, 3);

    expect(shares).toHaveLength(5);

    // Any 3 of 5 should reconstruct
    const recovered = combineShares([shares[0], shares[2], shares[4]]);
    expect(recovered.equals(secret)).toBe(true);
  });
});
