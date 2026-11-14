/**
 * The public verifier in @open-federation/pseudonym (src/verify.ts): what an
 * audience's phone runs on /verify, and what the stage demo's verifier runs.
 * It must agree with the PDS's own verifier, read keys only from the PLC
 * directory, and survive the trip through a QR-sized link.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import bs58 from 'bs58';
import { derivePseudonymKeys, generatePseudonymPhrase, signText, secp256k1DidKey } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildPseudonymGenesisOp, signGenesisOp, didForSignedOp } from '../../packages/openfederation-pseudonym/src/plc.js';
import { buildLinkStatement } from '../../packages/openfederation-pseudonym/src/formats.js';
import { signPresence, type RevealBundleV2 } from '../../packages/openfederation-pseudonym/src/client.js';
import {
  verifyRevealBundle, verifyPresence, checkPresence, challengeForWord, revealLinkFragment, presenceLinkFragment,
  parseVerifyLink, revealBundleFromLink, didKeyFromMultibase, verifyLink,
} from '../../packages/openfederation-pseudonym/src/verify.js';
import { deriveCustodyKeys, generateCustodyPhrase, signOwnerRaw } from '../../packages/openfederation-sdk/src/custody/index.js';
import { verifyRevealBundle as serverVerify, verifyPresence as serverPresence } from '../../src/identity/pseudonym/verify.js';

const PLC = 'http://plc.test';
const CONTEXT = 'OpenNewsrooms stage challenge';

/** A DID document as PLC serves it. */
function docWith(did: string, methods: Record<string, string>) {
  return {
    id: did,
    verificationMethod: Object.entries(methods).map(([name, didKey]) => ({
      id: `${did}#${name}`, type: 'Multikey', controller: did, publicKeyMultibase: didKey.slice('did:key:'.length),
    })),
  };
}

const ELENA = 'did:plc:elenaelenaelenaelenaelen';
const MARKO = 'did:plc:markomarkomarkomarkomark';

/** Elena with her own keys (self) and a custodial owner whose PDS holds an atproto key. */
const elenaKeys = deriveCustodyKeys(generateCustodyPhrase());
const pdsKey = secp256k1.utils.randomPrivateKey();
const pdsDidKey = secp256k1DidKey(secp256k1.getPublicKey(pdsKey, true));
const docs: Record<string, unknown> = {
  [ELENA]: docWith(ELENA, { atproto: pdsDidKey, openfederation_owner: elenaKeys.ownerDidKey }),
  [MARKO]: docWith(MARKO, { atproto: secp256k1DidKey(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true)) }),
};

function nightDesk(ownerDid = ELENA) {
  const phrase = generatePseudonymPhrase();
  const keys = derivePseudonymKeys(phrase);
  const genesisOp = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: keys.ownerDidKey, handle: 'nightdesk.pds.test',
    pdsEndpoint: 'https://pds.test', ownerDid, commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(genesisOp);
  docs[did] = docWith(did, { atproto: keys.ownerDidKey });
  logs[did] = [genesisOp];
  return { phrase, keys, genesisOp, did };
}

const logs: Record<string, unknown[]> = {};

/** A PLC directory in memory: GET /<did> and /<did>/log. */
function stubPlc(): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.origin !== PLC) return new Response('nope', { status: 500 });
    const [, did, tail] = url.pathname.split('/');
    const body = tail === 'log' ? logs[did] : tail === undefined ? docs[did] : undefined;
    return body ? Response.json(body) : new Response('{}', { status: 404 });
  });
}
afterEach(() => { vi.unstubAllGlobals(); });

function reveal(nd: ReturnType<typeof nightDesk>, owner: 'person' | 'custodial'): RevealBundleV2 {
  const statement = buildLinkStatement({ pseudonymDid: nd.did, ownerDid: ELENA, issuedAt: '2026-11-13T19:30:00.000Z' });
  return {
    version: 2, statement, commitmentSalt: nd.keys.commitmentSaltHex,
    pseudonym: { did: nd.did, sig: signText(nd.keys.ownerPrivateKey, statement), genesisOp: nd.genesisOp },
    owner: owner === 'person'
      ? { did: ELENA, keyRef: 'openfederation_owner', signingKey: elenaKeys.ownerDidKey, signature: signOwnerRaw(elenaKeys.ownerPrivateKey, statement) }
      : { did: ELENA, keyRef: 'atproto', signingKey: pdsDidKey, signature: { format: 'raw', sig: signText(pdsKey, statement) } },
  };
}

/** Marko copies Elena's proof and puts his own account in it. */
function markoClaims(b: RevealBundleV2): RevealBundleV2 {
  const c = structuredClone(b);
  c.statement = c.statement.replace(ELENA, MARKO);
  c.owner.did = MARKO;
  return c;
}

const online = { online: true, plcUrl: PLC };

describe('public verifier: reveal bundles', () => {
  it('Elena signing with her own key: VALID, signed by the person', async () => {
    stubPlc();
    const r = await verifyRevealBundle(reveal(nightDesk(), 'person'), online);
    expect(r).toMatchObject({ valid: true, ownerKeyBound: 'confirmed', ownerKeyRef: 'openfederation_owner', ownerAttestation: 'person' });
  });

  it('a custodial reveal: VALID, signed by the server-held key', async () => {
    stubPlc();
    const r = await verifyRevealBundle(reveal(nightDesk(), 'custodial'), online);
    expect(r).toMatchObject({ valid: true, ownerKeyRef: 'atproto', ownerAttestation: 'pds-held-key' });
  });

  it('a person bundle claiming a key the DID does not name: INVALID online', async () => {
    stubPlc();
    const b = reveal(nightDesk(), 'person');
    const other = deriveCustodyKeys(generateCustodyPhrase());
    b.owner.signingKey = other.ownerDidKey;
    b.owner.signature = signOwnerRaw(other.ownerPrivateKey, b.statement);
    const r = await verifyRevealBundle(b, online);
    expect(r.valid).toBe(false);
    expect(r.checks.find((c) => c.name === 'ownerKeyCurrent')?.ok).toBe(false);
    expect(r.ownerAttestation).toBe('unchecked');
  });

  it('Marko claims Night Desk: INVALID (Night Desk never signed it, the sealed note does not name him)', async () => {
    stubPlc();
    const r = await verifyRevealBundle(markoClaims(reveal(nightDesk(), 'person')), online);
    expect(r.valid).toBe(false);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(['pseudonymSignature', 'commitment', 'ownerSignature']));
  });

  it('a tampered signature: INVALID', async () => {
    stubPlc();
    const b = reveal(nightDesk(), 'person');
    b.pseudonym.sig = signText(derivePseudonymKeys(generatePseudonymPhrase()).ownerPrivateKey, b.statement);
    expect((await verifyRevealBundle(b, online)).valid).toBe(false);
  });

  it('never throws on rubbish', async () => {
    expect(await verifyRevealBundle(null)).toMatchObject({ valid: false });
    expect(await verifyRevealBundle({ version: 2, statement: 'x' })).toMatchObject({ valid: false });
  });

  it('agrees with the PDS verifier, check by check', async () => {
    stubPlc();
    const nd = nightDesk();
    const cases = [reveal(nd, 'person'), reveal(nd, 'custodial'), markoClaims(reveal(nd, 'person')), markoClaims(reveal(nd, 'custodial'))];
    const resolveDoc = async (did: string) => (docs[did] as Record<string, unknown>) ?? null;
    for (const b of cases) {
      for (const opts of [{}, { online: true, resolveDoc }]) {
        const ours = await verifyRevealBundle(b, opts);
        const theirs = await serverVerify(b as never, opts);
        expect(ours).toEqual(theirs);
      }
    }
  });

  it('reads legacy (uncompressed secp256k1) and Multikey document keys', () => {
    const legacy = `z${bs58.encode(secp256k1.getPublicKey(pdsKey, false))}`;
    expect(didKeyFromMultibase(legacy)).toBe(pdsDidKey);
    expect(didKeyFromMultibase(pdsDidKey.slice('did:key:'.length))).toBe(pdsDidKey);
    expect(didKeyFromMultibase('not-multibase')).toBeNull();
  });
});

describe('public verifier: presence', () => {
  const sign = (nd: ReturnType<typeof nightDesk>, word: string, phrase = nd.phrase) =>
    signPresence({ phrase, pseudonymDid: nd.did, challenge: challengeForWord(word, CONTEXT) }).signature;

  it('the challenge is the stage demo\'s: sha256 of the context, a newline and the word', () => {
    expect(challengeForWord('  Lantern ', CONTEXT)).toBe(challengeForWord('lantern', CONTEXT));
    expect(challengeForWord('lantern', CONTEXT)).toMatch(/^[0-9a-f]{64}$/);
    expect(challengeForWord('lantern', CONTEXT)).not.toBe(challengeForWord('lantern', 'another context'));
  });

  it('VALID for Night Desk\'s words, with the key from the directory', async () => {
    stubPlc();
    const nd = nightDesk();
    const r = await checkPresence({ plcUrl: PLC, pseudonymDid: nd.did, challenge: challengeForWord('lantern', CONTEXT), signature: sign(nd, 'lantern') });
    expect(r).toEqual({ valid: true, directoryKey: nd.keys.ownerDidKey });
  });

  it('INVALID for a stranger\'s words, a wrong word, a tampered signature or another DID', async () => {
    stubPlc();
    const nd = nightDesk();
    const other = nightDesk();
    const challenge = challengeForWord('lantern', CONTEXT);
    const good = sign(nd, 'lantern');
    const check = (did: string, signature: string, ch = challenge) => checkPresence({ plcUrl: PLC, pseudonymDid: did, challenge: ch, signature });
    expect((await check(nd.did, sign(nd, 'lantern', generatePseudonymPhrase()))).valid).toBe(false);
    expect((await check(nd.did, good, challengeForWord('harbour', CONTEXT))).valid).toBe(false);
    expect((await check(nd.did, good.slice(0, -2) + (good.endsWith('A') ? 'BA' : 'AA'))).valid).toBe(false);
    expect((await check(other.did, good)).valid).toBe(false);
    expect(await check('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', good)).toMatchObject({ valid: false, error: 'Not found in the directory' });
  });

  it('agrees with the PDS verifier', async () => {
    const nd = nightDesk();
    const challenge = challengeForWord('lantern', CONTEXT);
    for (const signature of [sign(nd, 'lantern'), sign(nd, 'harbour')]) {
      const p = { pseudonymDid: nd.did, genesisOp: nd.genesisOp as never, challenge, signature };
      expect(verifyPresence(p)).toBe(await serverPresence(p));
    }
  });
});

describe('verifier links', () => {
  it('a reveal fits a QR code and comes back as the same verdict', async () => {
    stubPlc();
    for (const kind of ['person', 'custodial'] as const) {
      const b = reveal(nightDesk(), kind);
      const fragment = revealLinkFragment(b);
      expect(fragment.length).toBeLessThan(330);
      const link = parseVerifyLink(`#${fragment}`);
      expect(link.kind).toBe('reveal');
      const rebuilt = await revealBundleFromLink(link as Extract<typeof link, { kind: 'reveal' }>, { plcUrl: PLC });
      expect(rebuilt).toEqual(b);
      expect((await verifyRevealBundle(rebuilt, online)).ownerAttestation).toBe(kind === 'person' ? 'person' : 'pds-held-key');
    }
  });

  it('a reveal link with Marko\'s DID swapped in verifies INVALID', async () => {
    stubPlc();
    const fragment = revealLinkFragment(reveal(nightDesk(), 'custodial'));
    const swapped = fragment.replace(`o=${ELENA.slice(8)}`, `o=${MARKO.slice(8)}`);
    const link = parseVerifyLink(swapped) as Extract<ReturnType<typeof parseVerifyLink>, { kind: 'reveal' }>;
    expect(link.ownerDid).toBe(MARKO);
    expect((await verifyRevealBundle(await revealBundleFromLink(link, { plcUrl: PLC }), online)).valid).toBe(false);
  });

  it('a presence link round-trips', () => {
    const fragment = presenceLinkFragment({ pseudonymDid: ELENA, word: ' Lantern ', signature: 'abc_-' });
    expect(parseVerifyLink(fragment)).toEqual({ kind: 'presence', pseudonymDid: ELENA, word: 'Lantern', signature: 'abc_-' });
  });

  it('refuses malformed links', () => {
    expect(() => parseVerifyLink('')).toThrow();
    expect(() => parseVerifyLink('r=2&p=x')).toThrow();
    expect(() => parseVerifyLink('w=a&d=did%3Aweb%3Aevil&s=x')).toThrow();
    expect(() => parseVerifyLink('w=%20&d=elenaelenaelenaelenaelen&s=x')).toThrow();
  });
});

describe('verifyLink: what the /verify page shows', () => {
  const opts = { plcUrl: PLC, presenceContext: CONTEXT };

  it('a presence link: VALID with Night Desk\'s handle; a wrong word, a tampered signature or another DID: INVALID', async () => {
    stubPlc();
    const nd = nightDesk();
    (docs[nd.did] as { alsoKnownAs?: string[] }).alsoKnownAs = ['at://nightdesk.pds.test'];
    const signature = signPresence({ phrase: nd.phrase, pseudonymDid: nd.did, challenge: challengeForWord('lantern', CONTEXT) }).signature;
    expect(await verifyLink(presenceLinkFragment({ pseudonymDid: nd.did, word: 'Lantern', signature }), opts))
      .toMatchObject({ kind: 'presence', valid: true, pseudonymHandle: 'nightdesk.pds.test', word: 'Lantern' });
    expect((await verifyLink(presenceLinkFragment({ pseudonymDid: nd.did, word: 'harbour', signature }), opts)).valid).toBe(false);
    const tampered = signature.slice(0, 10) + (signature[10] === 'A' ? 'B' : 'A') + signature.slice(11);
    expect((await verifyLink(presenceLinkFragment({ pseudonymDid: nd.did, word: 'lantern', signature: tampered }), opts)).valid).toBe(false);
    expect((await verifyLink(presenceLinkFragment({ pseudonymDid: nightDesk().did, word: 'lantern', signature }), opts)).valid).toBe(false);
  });

  it('a reveal link: who, and whether the person or the server-held key signed', async () => {
    stubPlc();
    (docs[ELENA] as { alsoKnownAs?: string[] }).alsoKnownAs = ['at://elena.pds.test'];
    const person = await verifyLink(revealLinkFragment(reveal(nightDesk(), 'person')), opts);
    expect(person).toMatchObject({ kind: 'reveal', valid: true, ownerDid: ELENA, ownerHandle: 'elena.pds.test', ownerAttestation: 'person' });
    const custodial = await verifyLink(revealLinkFragment(reveal(nightDesk(), 'custodial')), opts);
    expect(custodial).toMatchObject({ valid: true, ownerAttestation: 'pds-held-key' });
  });

  it('a reveal link for a DID the directory doesn\'t know: INVALID, with the reason', async () => {
    stubPlc();
    const fragment = revealLinkFragment(reveal(nightDesk(), 'person')).replace(/p=[a-z2-7]{24}/, 'p=aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(await verifyLink(fragment, opts)).toMatchObject({ valid: false, error: 'The pseudonym is not in the directory' });
  });
});
