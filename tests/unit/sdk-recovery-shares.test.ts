/**
 * Recovery shares (#238, ADR-003 decision 13, options 2 and 3): the recovery
 * phrase split k-of-n with Shamir over GF(256), in a share format with a
 * version, threshold, index, split id and checksum, printable as 20 words or
 * an `OFRS:` code.
 */
import { describe, it, expect } from 'vitest';
import {
  splitRecoveryPhrase, combineRecoveryShares, parseRecoveryShare, RecoveryShareError,
  RECOVERY_SHARE_WORDS, RECOVERY_SHARE_CODE_PREFIX, generateRecoveryPhrase, deriveRecoveryKey,
  type RecoveryShare, type RecoveryShareErrorCode,
} from '../../packages/openfederation-sdk/src/custody/index.js';
import { splitEntropy } from '../../packages/openfederation-sdk/src/custody/recovery-shares.js';
import { wordlist } from '@scure/bip39/wordlists/english';

const FIXED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [head, ...s]), ...subsets(rest, k)];
}

function refused(fn: () => unknown, code: RecoveryShareErrorCode): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RecoveryShareError);
    expect((e as RecoveryShareError).code).toBe(code);
    expect((e as Error).message.length).toBeGreaterThan(10);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** Deterministic "randomness": the bytes handed out in order. */
function fixedRandom(bytes: number[]): (n: number) => Uint8Array {
  let at = 0;
  return (n) => {
    const out = new Uint8Array(bytes.slice(at, at + n));
    at += n;
    return out;
  };
}

describe('splitRecoveryPhrase / combineRecoveryShares', () => {
  it.each([[2, 3], [3, 5]])('%i-of-%i: every subset of k shares gives back the exact phrase', (k, n) => {
    const phrase = generateRecoveryPhrase();
    const shares = splitRecoveryPhrase(phrase, { threshold: k, shares: n });
    expect(shares).toHaveLength(n);
    expect(shares.map((s) => s.index)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(new Set(shares.map((s) => s.splitId)).size).toBe(1);
    for (const s of shares) {
      expect(s.threshold).toBe(k);
      expect(s.version).toBe(1);
      expect(s.words.split(' ')).toHaveLength(RECOVERY_SHARE_WORDS);
      expect(s.code).toMatch(/^OFRS:[A-Z2-7]{44}$/);
    }
    const all = subsets(shares, k);
    expect(all.length).toBeGreaterThan(1);
    for (const subset of all) {
      expect(combineRecoveryShares(subset)).toBe(phrase);
      expect(combineRecoveryShares(subset.map((s) => s.words))).toBe(phrase);
      expect(combineRecoveryShares([...subset].reverse().map((s) => s.code))).toBe(phrase);
    }
    // All n agree too.
    expect(combineRecoveryShares(shares)).toBe(phrase);
    // And the phrase gives the same recovery key.
    expect(deriveRecoveryKey(combineRecoveryShares(shares.slice(0, k))).recoveryDidKey).toBe(deriveRecoveryKey(phrase).recoveryDidKey);
  });

  it('k-1 shares are refused, for every subset', () => {
    const shares = splitRecoveryPhrase(FIXED, { threshold: 3, shares: 5 });
    for (const subset of subsets(shares, 2)) refused(() => combineRecoveryShares(subset), 'NotEnoughShares');
    refused(() => combineRecoveryShares([]), 'NotEnoughShares');
  });

  it('a single share is consistent with every possible secret (it reveals nothing)', () => {
    // For threshold 2, share x=1 is s ^ a. For any candidate secret byte there is exactly one a
    // that explains it, so one share leaves all 256 values of each secret byte equally possible.
    const secret = new Uint8Array(16).fill(0x42);
    const random = fixedRandom([1, 2, 3, 4, ...new Array(16).fill(0x99)]);
    const [one] = splitEntropy(secret, 2, 3, random);
    const y = one[7];
    const explained = new Set<number>();
    for (let s = 0; s < 256; s++) explained.add(s ^ y); // the a for candidate s
    expect(explained.size).toBe(256);
  });

  it('different splits of the same phrase use different split ids and shares', () => {
    const a = splitRecoveryPhrase(FIXED, { threshold: 2, shares: 3 });
    const b = splitRecoveryPhrase(FIXED, { threshold: 2, shares: 3 });
    expect(a[0].splitId).not.toBe(b[0].splitId);
    expect(a[0].words).not.toBe(b[0].words);
  });

  it('refuses bad split parameters', () => {
    for (const [threshold, shares] of [[1, 3], [4, 3], [2, 17], [0, 0], [2.5, 3]]) {
      refused(() => splitRecoveryPhrase(FIXED, { threshold, shares }), 'InvalidSplit');
    }
    expect(() => splitRecoveryPhrase('not a phrase', { threshold: 2, shares: 3 })).toThrow('InvalidPhrase');
  });
});

describe('refusals', () => {
  const shares = splitRecoveryPhrase(FIXED, { threshold: 2, shares: 3 });

  it('mixed sets: shares from two splits, even of the same phrase', () => {
    const other = splitRecoveryPhrase(FIXED, { threshold: 2, shares: 3 });
    refused(() => combineRecoveryShares([shares[0], other[1]]), 'MixedShares');
    const otherThreshold = splitRecoveryPhrase(FIXED, { threshold: 3, shares: 3 });
    refused(() => combineRecoveryShares([shares[0], otherThreshold[1], otherThreshold[2]]), 'MixedShares');
  });

  it('duplicates: the same share twice does not count as two', () => {
    refused(() => combineRecoveryShares([shares[0], shares[0]]), 'DuplicateShare');
    refused(() => combineRecoveryShares([shares[0].words, shares[0].code]), 'DuplicateShare');
  });

  it('wrong checksum: a changed word, a changed code character, a swapped pair of words', () => {
    const words = shares[0].words.split(' ');
    const swapped = [...words];
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    if (swapped[3] !== swapped[4]) refused(() => parseRecoveryShare(swapped.join(' ')), 'ShareChecksumMismatch');
    // Change one bit in the middle of the share (word 10): the checksum catches it.
    const tampered = [...words];
    tampered[9] = wordlist[(wordlist.indexOf(words[9]) ^ 1) & 0x7ff];
    refused(() => combineRecoveryShares([tampered.join(' '), shares[1].words]), 'ShareChecksumMismatch');
    const code = shares[0].code;
    const at = 20;
    const flipped = code.slice(0, at) + (code[at] === 'A' ? 'B' : 'A') + code.slice(at + 1);
    refused(() => combineRecoveryShares([flipped, shares[1].code]), 'ShareChecksumMismatch');
  });

  it('a share object whose code was changed is checked again', () => {
    const forged: RecoveryShare = { ...shares[0], code: shares[0].code.slice(0, -3) + 'AAA' };
    expect(() => combineRecoveryShares([forged, shares[1]])).toThrow(RecoveryShareError);
  });

  it('an extra share that disagrees with the others is refused', () => {
    // Same split id and threshold, index 3, but other bytes (and a valid checksum): built by hand.
    const random = fixedRandom([9, 9, 9, 9, ...new Array(16).fill(7)]);
    const real = splitEntropy(new Uint8Array(16), 2, 3, random);
    const fake = splitEntropy(new Uint8Array(16).fill(1), 2, 3, fixedRandom([9, 9, 9, 9, ...new Array(16).fill(7)]));
    const toCode = (b: Uint8Array) => parseRecoveryShare(RECOVERY_SHARE_CODE_PREFIX + base32(b));
    refused(() => combineRecoveryShares([toCode(real[0]), toCode(real[1]), toCode(fake[2])]), 'MixedShares');
    // The real third share agrees; entropy 0 is "abandon … about".
    expect(combineRecoveryShares([toCode(real[0]), toCode(real[1]), toCode(real[2])])).toBe(FIXED);
  });

  it('unreadable input', () => {
    refused(() => parseRecoveryShare(''), 'InvalidShare');
    refused(() => parseRecoveryShare('abandon ability'), 'InvalidShare');
    refused(() => parseRecoveryShare(shares[0].words.replace(/^\S+/, 'notaword')), 'InvalidShare');
    refused(() => parseRecoveryShare('OFRS:ABC'), 'InvalidShare');
    refused(() => parseRecoveryShare('OFRS:' + '1'.repeat(44)), 'InvalidShare');
  });

  it('a share from a newer format version', () => {
    const bytes = splitEntropy(new Uint8Array(16), 2, 2, fixedRandom(new Array(20).fill(5)))[0];
    bytes[0] = 2;
    refused(() => parseRecoveryShare(RECOVERY_SHARE_CODE_PREFIX + base32(bytes)), 'UnsupportedShareVersion');
  });
});

describe('reading shares', () => {
  const [share] = splitRecoveryPhrase(FIXED, { threshold: 2, shares: 3 });

  it('accepts words with numbering, extra spaces and capitals, and codes in lower case or broken over lines', () => {
    const numbered = share.words.split(' ').map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join('\n');
    expect(parseRecoveryShare(numbered)).toEqual(share);
    expect(parseRecoveryShare(`  ${share.code.toLowerCase().slice(0, 20)}\n${share.code.toLowerCase().slice(20)} `)).toEqual(share);
    expect(parseRecoveryShare(share.code)).toEqual(share);
  });
});

describe('known vectors', () => {
  it('GF(256) arithmetic by hand: secret 0, coefficient 0x53 → shares 0x53, 0xa6, 0xf5', () => {
    // f(x) = 0x53·x over GF(2^8) mod x^8+x^4+x^3+x+1: 0x53·2 = 0xa6, 0x53·3 = 0xa6 ^ 0x53 = 0xf5.
    const shares = splitEntropy(new Uint8Array(16), 2, 3, fixedRandom([0, 0, 0, 0, ...new Array(16).fill(0x53)]));
    expect(Array.from(shares[0].subarray(7, 23))).toEqual(new Array(16).fill(0x53));
    expect(Array.from(shares[1].subarray(7, 23))).toEqual(new Array(16).fill(0xa6));
    expect(Array.from(shares[2].subarray(7, 23))).toEqual(new Array(16).fill(0xf5));
  });

  it('GF(256) reduction by hand: coefficient 0x80 at x=2 → 0x1b; 0x53·0xca = 1 (inverses)', () => {
    const shares = splitEntropy(new Uint8Array(16), 2, 2, fixedRandom([0, 0, 0, 0, ...new Array(16).fill(0x80)]));
    expect(shares[1][7]).toBe(0x1b);
    // Degree 2: f(x) = s + 0xca·x + 0x53·x^2 has f(1) = s ^ 0xca ^ 0x53.
    const s = 0x11;
    const deg2 = splitEntropy(new Uint8Array(16).fill(s), 3, 3, fixedRandom([0, 0, 0, 0, ...new Array(16).fill(0xca), ...new Array(16).fill(0x53)]));
    expect(deg2[0][7]).toBe(s ^ 0xca ^ 0x53);
  });

  it('a frozen 2-of-3 split of the BIP-39 test phrase', () => {
    const random = fixedRandom([0xde, 0xad, 0xbe, 0xef, ...Array.from({ length: 16 }, (_, i) => i * 17)]);
    const shares = splitEntropy(new Uint8Array(16), 2, 3, random)
      .map((b) => parseRecoveryShare(RECOVERY_SHARE_CODE_PREFIX + base32(b)));
    expect(shares.map((s) => s.splitId)).toEqual(['deadbeef', 'deadbeef', 'deadbeef']);
    expect(shares.map((s) => s.code)).toEqual(FROZEN_CODES);
    expect(shares.map((s) => s.words)).toEqual(FROZEN_WORDS);
    // Entropy 0 is "abandon … about".
    expect(combineRecoveryShares([FROZEN_WORDS[2], FROZEN_CODES[0]])).toBe(FIXED);
  });
});

// Checked independently: base32 and SHA-256 with Python's standard library, words by index into the BIP-39 list.
// Share 1 bytes: 01 02 01 deadbeef 00112233445566778899aabbccddeeff 7badd35b (version, k, x, split id, data, checksum).
const FROZEN_CODES = [
  'OFRS:AEBADXVNX3XQAEJCGNCFKZTXRCM2VO6M3XXP665N2NNQ',
  'OFRS:AEBAFXVNX3XQAISEM2EKVTHOBMUU63MDUHD6LJ4UJKMA',
  'OFRS:AEBAHXVNX3XQAM3GKXGP7KUZQOYOLVSPPQURVFTMVHFQ',
];
const FROZEN_WORDS = [
  'absurd avoid jeans fork upon length duty edit dust private over bachelor one fuel cricket saddle youth talent inquiry render',
  'absurd avoid response fork upon length math mimic master filter describe bind neutral replace attend decline toss device bargain copy',
  'absurd avoid waste fork upon length snow skirt smooth wool please alter atom twenty digital lunch box recall clerk noodle',
];

function base32(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += A[(acc >> bits) & 31]; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31];
  return out;
}
