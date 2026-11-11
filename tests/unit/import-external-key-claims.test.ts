/**
 * An imported repository's key claims are indexed only when the record carries
 * the claimant's proof for that very DID: otherwise anyone could import a claim
 * to someone else's public key (and block the real owner from claiming it).
 */
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { base58btc } from 'multiformats/bases/base58';
import { externalKeyClaimsToKeep } from '../../src/repo/import.js';
import { externalKeyProofMessage } from '../../src/identity/external-keys.js';

const COLLECTION = 'net.openfederation.identity.externalKey';
const ED25519_PREFIX = new Uint8Array([0xed, 0x01]);

function claim(did: string, rkey: string, opts: { proofFor?: string; omitProof?: boolean } = {}) {
  const kp = nacl.sign.keyPair();
  const publicKey = base58btc.encode(new Uint8Array([...ED25519_PREFIX, ...kp.publicKey]));
  const proof = Buffer.from(nacl.sign.detached(
    externalKeyProofMessage(opts.proofFor ?? did, rkey, 'ed25519', 'nostr', publicKey), kp.secretKey)).toString('base64url');
  const record: Record<string, unknown> = { type: 'ed25519', purpose: 'nostr', publicKey, createdAt: new Date().toISOString() };
  if (!opts.omitProof) record.proof = proof;
  return { collection: COLLECTION, rkey, record, cid: 'bafy' + rkey };
}

describe('externalKeyClaimsToKeep', () => {
  const did = 'did:plc:importer';
  it('keeps a claim whose stored proof verifies for this DID', () => {
    const kept = externalKeyClaimsToKeep(did, [claim(did, 'k1')] as never);
    expect(kept).toHaveLength(1);
  });
  it('drops a claim without a proof', () => {
    expect(externalKeyClaimsToKeep(did, [claim(did, 'k2', { omitProof: true })] as never)).toHaveLength(0);
  });
  it('drops a claim whose proof was made for another DID', () => {
    expect(externalKeyClaimsToKeep(did, [claim(did, 'k3', { proofFor: 'did:plc:victim' })] as never)).toHaveLength(0);
  });
  it('leaves other collections alone', () => {
    const other = { collection: 'app.bsky.feed.post', rkey: 'p', record: { text: 'hi' }, cid: 'bafyp' };
    expect(externalKeyClaimsToKeep(did, [other] as never)).toHaveLength(1);
  });
});
