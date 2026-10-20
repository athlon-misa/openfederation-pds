import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { verifySignature } from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import { generatePseudonymPhrase, derivePseudonymKeys } from '../../packages/openfederation-pseudonym/src/keys.js';
import {
  buildPseudonymGenesisOp, signGenesisOp, buildMoveOp, signPlcOp, cidForPlcOp,
} from '../../packages/openfederation-pseudonym/src/plc.js';
import { encodeDagCbor } from '../../src/identity/plc-client.js';
import { base64UrlDecode } from '../../packages/openfederation-pseudonym/src/formats.js';

describe('pseudonym move operation', () => {
  const keys = derivePseudonymKeys(generatePseudonymPhrase());
  const genesis = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: keys.ownerDidKey, handle: 'nd.example.test',
    pdsEndpoint: 'https://a.example', ownerDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);

  it('computes prev as the CIDv1 dag-cbor sha-256 of the previous signed op', async () => {
    const digest = await sha256.digest(encodeDagCbor(genesis));
    expect(cidForPlcOp(genesis)).toBe(CID.createV1(0x71, digest).toString());
  });

  it('keeps keys, handle and commitment, changes only the PDS, and is signed by the pseudonym key', async () => {
    const op = buildMoveOp({ previous: genesis, signingDidKey: 'did:key:zQ3shNewKey', pdsEndpoint: 'https://b.example' });
    expect(op.prev).toBe(cidForPlcOp(genesis));
    expect(op.rotationKeys).toEqual(genesis.rotationKeys);
    expect(op.alsoKnownAs).toEqual(genesis.alsoKnownAs);
    expect(op.verificationMethods.atproto).toBe('did:key:zQ3shNewKey');
    expect(op.services.atproto_pds.endpoint).toBe('https://b.example');
    const signed = signPlcOp(op, keys.ownerPrivateKey);
    expect(await verifySignature(keys.ownerDidKey, dagCbor.encode(op), base64UrlDecode(signed.sig))).toBe(true);
  });
});
