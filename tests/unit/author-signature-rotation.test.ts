/**
 * A member's signature on community content is checked against the atproto
 * key the DID names now (#240 phase 2). A key the DID has rotated away from no
 * longer counts: under device signing the server's own repo key is in every
 * such DID's history, and accepting it would let the server sign "member"
 * records the member never wrote.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { cidForRecord } from '@atproto/repo';
import { setPlcClientForTests } from '../../src/identity/plc-client.js';
import { verifyAuthorSignature } from '../../src/forum/member-content.js';

const DID = 'did:plc:rotatingauthor0000000000';

function op(atprotoKey: string) {
  return { type: 'plc_operation', rotationKeys: ['did:key:zQ3shRotation'], verificationMethods: { atproto: atprotoKey }, alsoKnownAs: [], services: {} };
}

function useLog(log: Record<string, unknown>[]) {
  setPlcClientForTests({
    registerDidPlc: async () => { throw new Error('not used'); },
    resolveFromPlc: async () => null,
    getPlcLog: async (did) => (did === DID ? log : null),
  });
}

async function signedRecord(keypair: Secp256k1Keypair, author = DID): Promise<Record<string, unknown>> {
  const unsigned = { $type: 'net.openfederation.forum.post', text: 'hello', author };
  const cid = await cidForRecord(unsigned);
  const sig = Buffer.from(await keypair.sign(cid.bytes)).toString('base64url');
  return { ...unsigned, authorSig: { key: keypair.did(), sig } };
}

describe('author signatures across key rotation', () => {
  afterEach(() => setPlcClientForTests(null));

  it('does not verify a record signed with a key the DID has since rotated away from', async () => {
    const oldKey = await Secp256k1Keypair.create();
    const newKey = await Secp256k1Keypair.create();
    const record = await signedRecord(oldKey);
    useLog([op(oldKey.did()), op(newKey.did())]);
    expect(await verifyAuthorSignature(record)).toBe(false);
  });

  it('verifies a record signed with the DID\'s current key, after a rotation', async () => {
    const oldKey = await Secp256k1Keypair.create();
    const newKey = await Secp256k1Keypair.create();
    useLog([op(oldKey.did()), op(newKey.did())]);
    expect(await verifyAuthorSignature(await signedRecord(newKey))).toBe(true);
  });

  it('does not verify a record whose authorSig names the current key but was signed by an old one', async () => {
    const oldKey = await Secp256k1Keypair.create();
    const newKey = await Secp256k1Keypair.create();
    const signed = await signedRecord(oldKey);
    useLog([op(oldKey.did()), op(newKey.did())]);
    const relabelled = { ...signed, authorSig: { ...(signed.authorSig as { sig: string }), key: newKey.did() } };
    expect(await verifyAuthorSignature(relabelled)).toBe(false);
  });

  it('does not verify a record signed with a key the DID never had', async () => {
    const stranger = await Secp256k1Keypair.create();
    const current = await Secp256k1Keypair.create();
    useLog([op(current.did())]);
    expect(await verifyAuthorSignature(await signedRecord(stranger))).toBe(false);
  });

  it('does not verify once the DID is tombstoned', async () => {
    const key = await Secp256k1Keypair.create();
    const record = await signedRecord(key);
    useLog([op(key.did()), { type: 'plc_tombstone' }]);
    expect(await verifyAuthorSignature(record)).toBe(false);
  });
});
