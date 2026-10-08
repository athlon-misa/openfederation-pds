import { describe, it, expect } from 'vitest';
import { verifySignature } from '@atproto/crypto';
import { derivePseudonymKeys } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildPseudonymGenesisOp, signGenesisOp, didForSignedOp } from '../../packages/openfederation-pseudonym/src/plc.js';
import { computeCommitment, commitmentUrn, base64UrlDecode } from '../../packages/openfederation-pseudonym/src/formats.js';
import { didForSignedOperation, encodeDagCbor } from '../../src/identity/plc-client.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('package genesis op is valid to the PDS', () => {
  const k = derivePseudonymKeys(PHRASE);
  const op = buildPseudonymGenesisOp({
    ownerDidKey: k.ownerDidKey, signingDidKey: k.ownerDidKey, handle: 'nightdesk.pds.test',
    pdsEndpoint: 'https://pds.test', ownerDid: 'did:plc:ana', commitmentSaltHex: k.commitmentSaltHex,
  });
  const signed = signGenesisOp(op, k.ownerPrivateKey);

  it('carries the handle and the commitment, owner key as sole rotation key', () => {
    expect(op.alsoKnownAs).toEqual(['at://nightdesk.pds.test', commitmentUrn(computeCommitment('did:plc:ana', k.commitmentSaltHex))]);
    expect(op.rotationKeys).toEqual([k.ownerDidKey]);
  });

  it('package and core derive the same DID', () => {
    const did = didForSignedOp(signed);
    expect(did).toMatch(/^did:plc:[a-z2-7]{24}$/);
    expect(didForSignedOperation(signed as unknown as Record<string, unknown>)).toBe(did);
  });

  it('genesis signature verifies with @atproto/crypto over core DAG-CBOR', async () => {
    const { sig, ...unsigned } = signed;
    expect(await verifySignature(k.ownerDidKey, encodeDagCbor(unsigned), base64UrlDecode(sig))).toBe(true);
  });
});
