import { describe, it, expect } from 'vitest';
import { derivePseudonymKeys, generatePseudonymPhrase } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildPseudonymGenesisOp, signGenesisOp, didForSignedOp } from '../../packages/openfederation-pseudonym/src/plc.js';
import { checkPseudonymGenesis } from '../../src/identity/pseudonym/genesis.js';

const EXPECT = { serviceUrl: 'https://pds.test', handleSuffix: '.pds.test' };

function make(over: Record<string, string> = {}, mutate?: (op: any) => void) {
  const k = derivePseudonymKeys(generatePseudonymPhrase());
  const op: any = buildPseudonymGenesisOp({
    ownerDidKey: k.ownerDidKey, signingDidKey: derivePseudonymKeys(generatePseudonymPhrase()).ownerDidKey,
    handle: 'nightdesk.pds.test', pdsEndpoint: 'https://pds.test', ownerDid: 'did:plc:ana',
    commitmentSaltHex: k.commitmentSaltHex, ...over,
  });
  mutate?.(op);
  const signed = signGenesisOp(op, k.ownerPrivateKey);
  return { k, signed, did: didForSignedOp(signed) };
}

describe('checkPseudonymGenesis', () => {
  it('accepts a well-formed pseudonym genesis op', async () => {
    const { k, signed, did } = make();
    expect(await checkPseudonymGenesis(did, signed as any, EXPECT)).toEqual({
      ok: true, handle: 'nightdesk.pds.test', ownerKey: k.ownerDidKey, signingKey: signed.verificationMethods.atproto,
    });
  });

  it('rejects a DID that is not the hash of the op, and a bad signature', async () => {
    const { signed } = make();
    expect(await checkPseudonymGenesis('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', signed as any, EXPECT)).toMatchObject({ ok: false, reason: 'DidMismatch' });
    const forged = { ...signed, sig: make().signed.sig };
    expect(await checkPseudonymGenesis(didForSignedOp(forged as any), forged as any, EXPECT)).toMatchObject({ ok: false, reason: 'BadSignature' });
  });

  it('rejects another PDS, a foreign handle, missing or doubled commitment, extra rotation keys', async () => {
    const cases: [ReturnType<typeof make>, string][] = [
      [make({ pdsEndpoint: 'https://evil.test' }), 'WrongService'],
      [make({ handle: 'nightdesk.evil.test' }), 'BadHandle'],
      [make({}, (op) => { op.alsoKnownAs = [op.alsoKnownAs[0]]; }), 'BadCommitment'],
      [make({}, (op) => { op.alsoKnownAs = [...op.alsoKnownAs, op.alsoKnownAs[1]]; }), 'BadCommitment'],
      [make({}, (op) => { op.rotationKeys = [...op.rotationKeys, op.rotationKeys[0]]; }), 'BadRotationKeys'],
    ];
    for (const [{ signed, did }, reason] of cases) {
      expect(await checkPseudonymGenesis(did, signed as any, EXPECT)).toMatchObject({ ok: false, reason });
    }
  });
});
