import { describe, it, expect } from 'vitest';
import { verifySignature } from '@atproto/crypto';
import {
  computeCommitment, commitmentUrn, commitmentsIn, COMMITMENT_URN_PREFIX,
  buildLinkStatement, parseLinkStatement, buildLoginMessage, buildPresenceMessage,
  base64UrlDecode, currentEpoch, previousEpoch,
} from '../../packages/openfederation-pseudonym/src/formats.js';
import { generatePseudonymPhrase, derivePseudonymKeys, signText } from '../../packages/openfederation-pseudonym/src/keys.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('pseudonym formats', () => {
  it('commitment is deterministic, hex, and owner-bound', () => {
    const salt = 'aa'.repeat(32);
    const a = computeCommitment('did:plc:ana', salt);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCommitment('did:plc:ana', salt)).toBe(a);
    expect(computeCommitment('did:plc:mallory', salt)).not.toBe(a);
    expect(computeCommitment('did:plc:ana', 'bb'.repeat(32))).not.toBe(a);
  });

  it('finds commitment URNs among alsoKnownAs', () => {
    const c = 'ab'.repeat(32);
    expect(commitmentUrn(c)).toBe(COMMITMENT_URN_PREFIX + c);
    expect(commitmentsIn(['at://x.test', commitmentUrn(c), 'urn:other'])).toEqual([c]);
    expect(commitmentsIn([COMMITMENT_URN_PREFIX + 'nothex'])).toEqual([]);
  });

  it('link statement round-trips and rejects anything non-canonical', () => {
    const p = { pseudonymDid: 'did:plc:night', ownerDid: 'did:plc:ana', issuedAt: '2026-10-08T10:00:00.000Z' };
    const s = buildLinkStatement(p);
    expect(s).toBe('OpenFederation Pseudonym Link v1\npseudonym: did:plc:night\nowner: did:plc:ana\nissued: 2026-10-08T10:00:00.000Z');
    expect(parseLinkStatement(s)).toEqual(p);
    expect(parseLinkStatement(s + '\n')).toBeNull();
    expect(parseLinkStatement(s.replace('Link v1', 'Link v2'))).toBeNull();
    expect(() => buildLinkStatement({ ...p, ownerDid: 'did:plc:a\nowner: did:plc:b' })).toThrow();
  });

  it('login and presence messages have distinct headers', () => {
    const ch = 'cd'.repeat(32);
    expect(buildLoginMessage({ serviceDid: 'did:web:pds.test', challenge: ch }))
      .toBe(`OpenFederation Pseudonym Login v1\nservice: did:web:pds.test\nchallenge: ${ch}`);
    expect(buildPresenceMessage({ pseudonymDid: 'did:plc:night', challenge: ch }))
      .toBe(`OpenFederation Pseudonym Presence v1\npseudonym: did:plc:night\nchallenge: ${ch}`);
  });

  it('epochs are UTC months', () => {
    expect(currentEpoch(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(previousEpoch('2026-10')).toBe('2026-09');
    expect(previousEpoch('2027-01')).toBe('2026-12');
  });
});

describe('pseudonym keys', () => {
  it('generates 12 valid words that differ every time', () => {
    const a = generatePseudonymPhrase();
    expect(a.split(' ')).toHaveLength(12);
    expect(generatePseudonymPhrase()).not.toBe(a);
    expect(() => derivePseudonymKeys(a)).not.toThrow();
  });

  it('derives the same keys from the same phrase, tolerant of case and spacing', () => {
    const a = derivePseudonymKeys(PHRASE);
    const b = derivePseudonymKeys(`  ${PHRASE.toUpperCase().replace(/ /g, '   ')} `);
    expect(b.ownerDidKey).toBe(a.ownerDidKey);
    expect(b.commitmentSaltHex).toBe(a.commitmentSaltHex);
    expect(a.ownerDidKey).toMatch(/^did:key:zQ3s/);
    expect(a.commitmentSaltHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects invalid, mistyped and non-12-word phrases', () => {
    expect(() => derivePseudonymKeys('hello world')).toThrow('InvalidPhrase');
    expect(() => derivePseudonymKeys(PHRASE.replace('about', 'abandon'))).toThrow('InvalidPhrase');
    expect(() => derivePseudonymKeys(Array(23).fill('abandon').concat('art').join(' '))).toThrow('InvalidPhrase');
  });

  it('signatures verify with @atproto/crypto', async () => {
    const k = derivePseudonymKeys(PHRASE);
    const sig = signText(k.ownerPrivateKey, 'hello');
    expect(await verifySignature(k.ownerDidKey, new TextEncoder().encode('hello'), base64UrlDecode(sig))).toBe(true);
    expect(await verifySignature(k.ownerDidKey, new TextEncoder().encode('other'), base64UrlDecode(sig))).toBe(false);
  });
});
