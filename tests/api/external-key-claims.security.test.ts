import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import { base58btc } from 'multiformats/bases/base58';
import { xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { externalKeyProofMessage } from '../../src/identity/external-keys.js';

const COLLECTION = 'net.openfederation.identity.externalKey';

describe('external key claims', () => {
  let plc = false;
  let user: { did: string; accessJwt: string };
  let communityDid: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    user = await createTestUser(uniqueHandle('ekclaim'));
    const created = await xrpcAuthPost('net.openfederation.community.create', user.accessJwt, {
      handle: uniqueHandle('ekc'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;
  });

  it('cannot be written into a community repository', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
      repo: communityDid, collection: COLLECTION,
      record: { $type: COLLECTION, type: 'ed25519', purpose: 'nostr', publicKey: 'z6Mkfake', createdAt: new Date().toISOString() },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UseDedicatedEndpoint');
  });

  it('setExternalKey keeps the proof in the record, so the claim can be checked later', async () => {
    if (!plc) return;
    const kp = nacl.sign.keyPair();
    const publicKey = base58btc.encode(new Uint8Array([0xed, 0x01, ...kp.publicKey]));
    const proof = Buffer.from(nacl.sign.detached(externalKeyProofMessage(user.did, 'k1', 'ed25519', 'nostr', publicKey), kp.secretKey)).toString('base64url');
    const res = await xrpcAuthPost('net.openfederation.identity.setExternalKey', user.accessJwt, {
      rkey: 'k1', type: 'ed25519', purpose: 'nostr', publicKey, proof,
    });
    expect(res.status).toBe(200);
    const row = (await query<{ record: { proof?: string } }>(
      'SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3', [user.did, COLLECTION, 'k1'])).rows[0];
    expect(row.record.proof).toBe(proof);
  });
});
