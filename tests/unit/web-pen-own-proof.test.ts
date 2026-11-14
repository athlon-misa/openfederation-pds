/**
 * The proof that names the account, made on the signed-out pen-name pages
 * (dashboard): the checks made before anything is signed. The sealed note
 * must name the account (its opener comes from the pen name's own words),
 * the person's words must hold the owner key the account publishes, and the
 * account offered from this browser's storage must be one the note names.
 */
import { describe, it, expect } from 'vitest';
import { commitmentUrn, computeCommitment, derivePseudonymKeys, generatePseudonymPhrase } from '@open-federation/pseudonym';
import { deriveCustodyKeys, generateCustodyPhrase } from '@open-federation/sdk/custody';
import {
  checkOwnerKey, isPlcDid, ownerCandidates, sealNames, sealedOwner, SEALED_TO_KEY, OWNER_KEY_PROBLEM, type StorageLike,
} from '../../web-interface/src/lib/pen-names/own-proof.js';

const OWNER = 'did:plc:abcdefghijklmnopqrstuvwx';
const OTHER = 'did:plc:zyxwvutsrqponmlkjihgfedc';
const PEN = 'did:plc:pqrstuvwxyzabcdefghijklm';

const penPhrase = generatePseudonymPhrase();
const salt = derivePseudonymKeys(penPhrase).commitmentSaltHex;
const sealedTo = (did: string) => ['at://pen.example.org', commitmentUrn(computeCommitment(did, salt))];

function store(entries: Record<string, unknown>): StorageLike {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (i) => keys[i] ?? null,
    getItem: (k) => (k in entries ? (typeof entries[k] === 'string' ? entries[k] as string : JSON.stringify(entries[k])) : null),
  };
}

describe('sealNames', () => {
  it('opens the note with the opener the pen name\'s words derive', () => {
    expect(sealNames(sealedTo(OWNER), OWNER, salt)).toBe(true);
    expect(sealNames(sealedTo(OWNER), `  ${OWNER} `, salt)).toBe(true);
  });

  it('refuses another account, another pen name\'s opener, or a malformed DID', () => {
    expect(sealNames(sealedTo(OWNER), OTHER, salt)).toBe(false);
    const otherSalt = derivePseudonymKeys(generatePseudonymPhrase()).commitmentSaltHex;
    expect(sealNames(sealedTo(OWNER), OWNER, otherSalt)).toBe(false);
    expect(sealNames(sealedTo(OWNER), 'not a did', salt)).toBe(false);
  });

  it('refuses an entry with no note, or more than one', () => {
    expect(sealNames(['at://pen.example.org'], OWNER, salt)).toBe(false);
    expect(sealNames(undefined, OWNER, salt)).toBe(false);
    expect(sealNames([...sealedTo(OWNER), ...sealedTo(OTHER).slice(1)], OWNER, salt)).toBe(false);
  });
});

describe('checkOwnerKey', () => {
  const words = generateCustodyPhrase();
  const mine = deriveCustodyKeys(words).ownerDidKey;
  const someoneElse = deriveCustodyKeys(generateCustodyPhrase()).ownerDidKey;

  it('accepts words whose owner key the account publishes', () => {
    expect(checkOwnerKey(mine, deriveCustodyKeys(words).ownerDidKey)).toBe('ok');
  });

  it('refuses other words', () => {
    expect(checkOwnerKey(someoneElse, mine)).toBe('other-key');
  });

  it('says a custodial account (no owner key published) cannot be signed for here', () => {
    expect(checkOwnerKey(null, mine)).toBe('no-owner-key');
    expect(checkOwnerKey(undefined, mine)).toBe('no-owner-key');
    expect(OWNER_KEY_PROBLEM['no-owner-key']).toMatch(/Custodial/);
    expect(OWNER_KEY_PROBLEM['no-owner-key']).toMatch(/account’s Pen names page, signed in/);
  });

  it('the pen name\'s own words do not pass for the account\'s', () => {
    // Same word list, different derivation path: a pen name's phrase never holds an account's owner key.
    expect(checkOwnerKey(mine, deriveCustodyKeys(penPhrase).ownerDidKey)).toBe('other-key');
  });
});

describe('ownerCandidates / sealedOwner', () => {
  it('offers the account this tab created the pen name for first', () => {
    // Kept as JSON, as the pen-name storage writes it.
    const tab = store({ [SEALED_TO_KEY(PEN)]: JSON.stringify(OWNER) });
    expect(ownerCandidates(PEN, store({ [SEALED_TO_KEY(PEN)]: OWNER }), null)).toEqual([OWNER]);
    const local = store({ [`of.penNames.passes.${OTHER}`]: { tokens: [] } });
    expect(ownerCandidates(PEN, tab, local)).toEqual([OWNER, OTHER]);
  });

  it('finds the account whose own list holds the pen name, before other accounts', () => {
    const local = store({
      [`of.penNames.passes.${OTHER}`]: { tokens: [] },
      [`of.penNames.list.${OWNER}`]: [{ did: PEN, handle: 'pen.example.org' }],
      'of.penNames.list.signed-out': [{ did: PEN }],
    });
    expect(ownerCandidates(PEN, null, local)).toEqual([OWNER, OTHER]);
  });

  it('reads only the DID of the dashboard\'s sign-in, and ignores junk', () => {
    const local = store({
      'openfed-auth': { state: { did: OWNER, refreshToken: 'secret' } },
      'of.penNames.collected.nonsense': { epoch: '2026-11' },
      unrelated: 'x',
      [`of.penNames.list.${OTHER}`]: '{not json',
    });
    const out = ownerCandidates(PEN, null, local);
    expect(out).toEqual([OTHER, OWNER]);
    expect(out.join()).not.toContain('secret');
  });

  it('never offers the pen name itself, and works with no storage at all', () => {
    expect(ownerCandidates(PEN, store({ [SEALED_TO_KEY(PEN)]: PEN }), null)).toEqual([]);
    expect(ownerCandidates(PEN, null, null)).toEqual([]);
  });

  it('offers only an account the sealed note names', () => {
    expect(sealedOwner([OTHER, OWNER], sealedTo(OWNER), salt)).toBe(OWNER);
    expect(sealedOwner([OTHER], sealedTo(OWNER), salt)).toBeNull();
    expect(sealedOwner([], sealedTo(OWNER), salt)).toBeNull();
  });
});

describe('isPlcDid', () => {
  it('accepts a did:plc and nothing else', () => {
    expect(isPlcDid(OWNER)).toBe(true);
    expect(isPlcDid(` ${OWNER}\n`)).toBe(true);
    expect(isPlcDid('did:web:example.org')).toBe(false);
    expect(isPlcDid('alice.example.org')).toBe(false);
  });
});
