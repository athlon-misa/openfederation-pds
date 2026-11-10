/**
 * An external key record says "this DID controls this key", and is only worth
 * anything because setExternalKey demands proof. It must not be writable
 * through the generic record endpoints, which demand none.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';

const COLLECTION = 'net.openfederation.identity.externalKey';

describe('external key proof of possession', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('refuses a hand-written external key record in your own repo', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('extkey'));
    const record = { $type: COLLECTION, type: 'ed25519', purpose: 'meshtastic', publicKey: 'z6MkvictimKeyThatIsNotMine', createdAt: new Date().toISOString() };
    for (const [nsid, body] of [
      ['com.atproto.repo.createRecord', { repo: user.did, collection: COLLECTION, record }],
      ['com.atproto.repo.putRecord', { repo: user.did, collection: COLLECTION, rkey: 'stolen', record }],
    ] as const) {
      const res = await xrpcAuthPost(nsid, user.accessJwt, body);
      expect(res.status, nsid).toBe(400);
      expect(res.body.error).toBe('UseDedicatedEndpoint');
    }
  });
});
