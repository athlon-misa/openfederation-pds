/**
 * Recovery shares (#238, ADR-003 decision 13, options 2 and 3): the recovery
 * phrase split k-of-n with Shamir's secret sharing, so it can be held by
 * people the person trusts (or a newsroom plus others) instead of on paper.
 *
 * What is split is the recovery phrase's 16 bytes of BIP-39 entropy, byte by
 * byte, over GF(256) (the AES field, x^8 + x^4 + x^3 + x + 1). Any k shares
 * give back the exact phrase; fewer than k say nothing about it (each byte
 * fits every value equally). The PDS takes no part: shares are made on the
 * device and handed over outside OpenFederation.
 *
 * A share is 27 bytes:
 *
 *   0       version (1)
 *   1       threshold k (2..16)
 *   2       share index x (1..16)
 *   3..6    split id: 4 random bytes, the same in every share of one split
 *   7..22   the share of the 16-byte entropy
 *   23..26  checksum: SHA-256("openfederation-recovery-share" || bytes 0..22), first 4 bytes
 *
 * and has two printable forms carrying the same bytes:
 *
 *   - words: 20 words from the BIP-39 English list, 11 bits each, big-endian
 *     (the last 4 bits are zero);
 *   - code: `OFRS:` and the bytes in RFC 4648 base32 (44 characters, no
 *     padding), which fits a QR code's alphanumeric mode.
 */
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { normalizePhrase } from './keys.js';

export const RECOVERY_SHARE_VERSION = 1;
/** The most shares one split makes. */
export const MAX_RECOVERY_SHARES = 16;
/** Words in a share. */
export const RECOVERY_SHARE_WORDS = 20;
export const RECOVERY_SHARE_CODE_PREFIX = 'OFRS:';

const SECRET_LENGTH = 16;
const HEADER = 7;
const CHECKSUM = 4;
const SHARE_LENGTH = HEADER + SECRET_LENGTH + CHECKSUM;
const CHECKSUM_TAG = new TextEncoder().encode('openfederation-recovery-share');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type RecoveryShareErrorCode =
  | 'InvalidSplit'
  | 'InvalidShare'
  | 'UnsupportedShareVersion'
  | 'ShareChecksumMismatch'
  | 'MixedShares'
  | 'DuplicateShare'
  | 'NotEnoughShares';

export class RecoveryShareError extends Error {
  readonly code: RecoveryShareErrorCode;
  constructor(code: RecoveryShareErrorCode, message: string) {
    super(message);
    this.name = 'RecoveryShareError';
    this.code = code;
  }
}

export interface RecoveryShare {
  version: number;
  /** Shares needed to recover (k). */
  threshold: number;
  /** This share's number, 1..n. */
  index: number;
  /** 8 hex characters, the same in every share of one split. */
  splitId: string;
  /** 20 words. */
  words: string;
  /** `OFRS:` + base32, for a QR code or pasting. */
  code: string;
}

// --- GF(256) ---------------------------------------------------------------

function gfMul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    p ^= -(b & 1) & a;
    const carry = -((a >> 7) & 1) & 0x1b;
    a = ((a << 1) ^ carry) & 0xff;
    b >>= 1;
  }
  return p;
}

/** a^254 = a^-1 for a != 0. */
function gfInv(a: number): number {
  let result = 1;
  let base = a;
  for (let e = 254; e > 0; e >>= 1) {
    if (e & 1) result = gfMul(result, base);
    base = gfMul(base, base);
  }
  return result;
}

/** The polynomial through `points` (distinct non-zero x), evaluated at `x`, byte by byte. */
function interpolate(points: { x: number; y: Uint8Array }[], x: number): Uint8Array {
  const out = new Uint8Array(points[0].y.length);
  for (let i = 0; i < points.length; i++) {
    // Lagrange basis l_i(x) = prod_{j!=i} (x - x_j) / (x_i - x_j); minus is xor in GF(2^8).
    let num = 1;
    let den = 1;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      num = gfMul(num, x ^ points[j].x);
      den = gfMul(den, points[i].x ^ points[j].x);
    }
    const l = gfMul(num, gfInv(den));
    const y = points[i].y;
    for (let b = 0; b < out.length; b++) out[b] ^= gfMul(y[b], l);
  }
  return out;
}

/** @internal Exported for tests (fixed randomness); use splitRecoveryPhrase. */
export function splitEntropy(entropy: Uint8Array, threshold: number, shares: number, random: (n: number) => Uint8Array): Uint8Array[] {
  if (!Number.isInteger(threshold) || !Number.isInteger(shares) || threshold < 2 || shares < threshold || shares > MAX_RECOVERY_SHARES) {
    throw new RecoveryShareError('InvalidSplit', `Choose at least 2 shares needed, no more than the number of shares, and at most ${MAX_RECOVERY_SHARES} shares`);
  }
  if (entropy.length !== SECRET_LENGTH) throw new RecoveryShareError('InvalidSplit', 'Only a 12-word recovery phrase can be split');
  const splitId = random(4);
  // coefficients[c][b]: coefficient of x^(c+1) for byte b.
  const coefficients = Array.from({ length: threshold - 1 }, () => random(SECRET_LENGTH));
  const out: Uint8Array[] = [];
  for (let x = 1; x <= shares; x++) {
    const bytes = new Uint8Array(SHARE_LENGTH);
    bytes[0] = RECOVERY_SHARE_VERSION;
    bytes[1] = threshold;
    bytes[2] = x;
    bytes.set(splitId, 3);
    for (let b = 0; b < SECRET_LENGTH; b++) {
      // Horner: ((a_{k-1} x + a_{k-2}) x + ...) x + secret
      let y = 0;
      for (let c = coefficients.length - 1; c >= 0; c--) y = gfMul(y ^ coefficients[c][b], x);
      bytes[HEADER + b] = y ^ entropy[b];
    }
    bytes.set(checksumOf(bytes.subarray(0, HEADER + SECRET_LENGTH)), HEADER + SECRET_LENGTH);
    out.push(bytes);
  }
  return out;
}

function checksumOf(body: Uint8Array): Uint8Array {
  const input = new Uint8Array(CHECKSUM_TAG.length + body.length);
  input.set(CHECKSUM_TAG);
  input.set(body, CHECKSUM_TAG.length);
  return sha256(input).subarray(0, CHECKSUM);
}

// --- printable forms -------------------------------------------------------

function bytesToWords(bytes: Uint8Array): string {
  const words: string[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 11) {
      bits -= 11;
      words.push(wordlist[(acc >> bits) & 0x7ff]);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) words.push(wordlist[(acc << (11 - bits)) & 0x7ff]);
  return words.join(' ');
}

function wordsToBytes(words: string[]): Uint8Array {
  if (words.length !== RECOVERY_SHARE_WORDS) {
    throw new RecoveryShareError('InvalidShare', `A share has ${RECOVERY_SHARE_WORDS} words; this has ${words.length}`);
  }
  const out = new Uint8Array(SHARE_LENGTH);
  let acc = 0;
  let bits = 0;
  let n = 0;
  words.forEach((w, i) => {
    const v = wordlist.indexOf(w);
    if (v === -1) throw new RecoveryShareError('InvalidShare', `Word ${i + 1} ("${w}") is not on the word list; check its spelling`);
    acc = (acc << 11) | v;
    bits += 11;
    while (bits >= 8 && n < SHARE_LENGTH) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  });
  if (acc !== 0) throw new RecoveryShareError('ShareChecksumMismatch', 'The last word does not fit: one of the words is wrong');
  return out;
}

function bytesToBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

function base32ToBytes(text: string): Uint8Array {
  const expected = Math.ceil((SHARE_LENGTH * 8) / 5);
  if (text.length !== expected) throw new RecoveryShareError('InvalidShare', 'This share code is incomplete or too long; copy or scan it again');
  const out = new Uint8Array(SHARE_LENGTH);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of text) {
    const v = BASE32.indexOf(ch);
    if (v === -1) throw new RecoveryShareError('InvalidShare', `"${ch}" cannot appear in a share code; copy or scan it again`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8 && n < SHARE_LENGTH) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new RecoveryShareError('ShareChecksumMismatch', 'This share code is damaged; copy or scan it again');
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function shareFromBytes(bytes: Uint8Array): RecoveryShare {
  if (bytes[0] !== RECOVERY_SHARE_VERSION) {
    throw new RecoveryShareError('UnsupportedShareVersion', `This share was made by a newer version (format ${bytes[0]}); update the app`);
  }
  const expected = checksumOf(bytes.subarray(0, HEADER + SECRET_LENGTH));
  const actual = bytes.subarray(HEADER + SECRET_LENGTH);
  if (expected.some((b, i) => b !== actual[i])) {
    throw new RecoveryShareError('ShareChecksumMismatch', 'This share does not check out: a word or character is wrong, or it was changed');
  }
  const threshold = bytes[1];
  const index = bytes[2];
  if (threshold < 2 || threshold > MAX_RECOVERY_SHARES || index < 1 || index > MAX_RECOVERY_SHARES) {
    throw new RecoveryShareError('InvalidShare', 'This share is not valid');
  }
  return {
    version: bytes[0],
    threshold,
    index,
    splitId: hex(bytes.subarray(3, HEADER)),
    words: bytesToWords(bytes),
    code: RECOVERY_SHARE_CODE_PREFIX + bytesToBase32(bytes),
  };
}

function shareBytes(share: RecoveryShare): Uint8Array {
  return base32ToBytes(share.code.slice(RECOVERY_SHARE_CODE_PREFIX.length));
}

/**
 * A share as typed, pasted or scanned: its 20 words (numbering such as
 * "1." or "3)" is ignored) or its `OFRS:` code. Checks the checksum.
 */
export function parseRecoveryShare(input: string): RecoveryShare {
  const text = input.trim();
  const compact = text.replace(/\s+/g, '').toUpperCase();
  if (compact.startsWith(RECOVERY_SHARE_CODE_PREFIX)) {
    return shareFromBytes(base32ToBytes(compact.slice(RECOVERY_SHARE_CODE_PREFIX.length)));
  }
  const words = text.toLowerCase().split(/[\s,]+/).filter((w) => w && !/^\d+[.):]?$/.test(w));
  if (words.length === 0) throw new RecoveryShareError('InvalidShare', 'Enter the share\'s words or its code');
  return shareFromBytes(wordsToBytes(words));
}

/**
 * Split a 12-word recovery phrase (generateRecoveryPhrase) into `shares`
 * shares, any `threshold` of which give it back. 2 <= threshold <= shares <= 16.
 * Show each share once, to the person who will hold it.
 */
export function splitRecoveryPhrase(phrase: string, p: { threshold: number; shares: number }): RecoveryShare[] {
  const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
  return splitEntropy(entropy, p.threshold, p.shares, randomBytes).map(shareFromBytes);
}

/**
 * The recovery phrase back from at least `threshold` shares of one split
 * (words, codes, or parsed shares). Refuses, with a RecoveryShareError:
 * a damaged share (ShareChecksumMismatch), shares of different splits
 * (MixedShares), the same share twice (DuplicateShare), and too few
 * (NotEnoughShares). Extra shares beyond the threshold must agree.
 */
export function combineRecoveryShares(input: Array<string | RecoveryShare>): string {
  if (input.length === 0) throw new RecoveryShareError('NotEnoughShares', 'No shares given');
  const shares = input.map((s) => (typeof s === 'string' ? parseRecoveryShare(s) : parseRecoveryShare(s.code)));
  const first = shares[0];
  for (const s of shares) {
    if (s.splitId !== first.splitId || s.threshold !== first.threshold) {
      throw new RecoveryShareError('MixedShares', 'These shares come from different splits; use shares made at the same time');
    }
  }
  const byIndex = new Map<number, RecoveryShare>();
  for (const s of shares) {
    const seen = byIndex.get(s.index);
    if (seen) {
      throw seen.code === s.code
        ? new RecoveryShareError('DuplicateShare', `Share ${s.index} was entered twice; each share counts once`)
        : new RecoveryShareError('MixedShares', `Two different shares claim to be share ${s.index}`);
    }
    byIndex.set(s.index, s);
  }
  if (shares.length < first.threshold) {
    throw new RecoveryShareError('NotEnoughShares', `${first.threshold} shares are needed; you have ${shares.length}`);
  }
  const points = shares.map((s) => ({ x: s.index, y: shareBytes(s).subarray(HEADER, HEADER + SECRET_LENGTH) }));
  const basis = points.slice(0, first.threshold);
  for (const extra of points.slice(first.threshold)) {
    const expected = interpolate(basis, extra.x);
    if (expected.some((b, i) => b !== extra.y[i])) {
      throw new RecoveryShareError('MixedShares', `Share ${extra.x} does not agree with the others`);
    }
  }
  return entropyToMnemonic(interpolate(basis, 0), wordlist);
}
