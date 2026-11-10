/**
 * Contact relationships are written to two repositories and an index. Doing
 * the same thing twice, or twice at once, must leave one of each, and requests
 * cannot be used to store or broadcast arbitrary data.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };
const CONTACT = 'net.openfederation.contact.contact';
const BLOCK = 'net.openfederation.contact.block';

const recordCount = async (repo: string, collection: string, subject: string) => Number((await query<{ c: string }>(
  `SELECT COUNT(*) AS c FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>'subject' = $3`,
  [repo, collection, subject])).rows[0].c);

describe('contact consistency', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  async function pendingRequest(from: User, to: User): Promise<string> {
    const sent = await xrpcAuthPost('net.openfederation.contact.sendRequest', from.accessJwt, { subject: to.did });
    expect(sent.status).toBe(200);
    return sent.body.rkey;
  }

  it('accepting the same request several times at once makes one contact on each side', async () => {
    if (!plc) return;
    const alice = await createTestUser(uniqueHandle('cc-a'));
    const bob = await createTestUser(uniqueHandle('cc-b'));
    const rkey = await pendingRequest(alice, bob);

    const results = await Promise.all([1, 2, 3].map(() =>
      xrpcAuthPost('net.openfederation.contact.respondToRequest', bob.accessJwt, { rkey, action: 'accept' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);

    expect(await recordCount(bob.did, CONTACT, alice.did)).toBe(1);
    expect(await recordCount(alice.did, CONTACT, bob.did)).toBe(1);
    const index = await query('SELECT 1 FROM contacts WHERE (user_did = $1 AND contact_did = $2) OR (user_did = $2 AND contact_did = $1)', [alice.did, bob.did]);
    expect(index.rows.length).toBe(2);
  });

  it('an acceptance that was interrupted half-way can be completed without duplicating anything', async () => {
    if (!plc) return;
    const alice = await createTestUser(uniqueHandle('cc-a'));
    const bob = await createTestUser(uniqueHandle('cc-b'));
    const rkey = await pendingRequest(alice, bob);

    // What a crash after the first of the four writes leaves behind: bob's
    // contact record exists, nothing else does, and the request is still pending.
    const half = await xrpcAuthPost('com.atproto.repo.createRecord', bob.accessJwt, {
      repo: bob.did, collection: CONTACT, record: { subject: alice.did, acceptedAt: new Date().toISOString() },
    });
    expect(half.status).toBe(200);

    const res = await xrpcAuthPost('net.openfederation.contact.respondToRequest', bob.accessJwt, { rkey, action: 'accept' });
    expect(res.status).toBe(200);
    expect(await recordCount(bob.did, CONTACT, alice.did)).toBe(1);
    expect(await recordCount(alice.did, CONTACT, bob.did)).toBe(1);
    const list = await xrpcAuthGet('net.openfederation.contact.list', bob.accessJwt);
    expect(list.body.contacts.filter((c: any) => c.did === alice.did)).toHaveLength(1);
  });

  it('blocking someone twice leaves one block record, which one unblock removes', async () => {
    if (!plc) return;
    const alice = await createTestUser(uniqueHandle('cc-a'));
    const bob = await createTestUser(uniqueHandle('cc-b'));
    for (let i = 0; i < 3; i++) {
      const res = await xrpcAuthPost('net.openfederation.contact.block', alice.accessJwt, { subject: bob.did });
      expect(res.status).toBe(200);
    }
    expect(await recordCount(alice.did, BLOCK, bob.did)).toBe(1);
    const un = await xrpcAuthPost('net.openfederation.contact.unblock', alice.accessJwt, { subject: bob.did });
    expect(un.status).toBe(200);
    expect(await recordCount(alice.did, BLOCK, bob.did)).toBe(0);
  });

  it('refuses an oversized or non-text note, and a request to something that is not an account here', async () => {
    if (!plc) return;
    const alice = await createTestUser(uniqueHandle('cc-a'));
    const bob = await createTestUser(uniqueHandle('cc-b'));
    const tooLong = await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, { subject: bob.did, note: 'x'.repeat(5000) });
    expect(tooLong.status).toBe(400);
    const notText = await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, { subject: bob.did, note: { a: 1 } });
    expect(notText.status).toBe(400);
    const nobody = await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, { subject: 'did:plc:nobodyatallhere000000000' });
    expect(nobody.status).toBe(404);
    const rows = await query(`SELECT 1 FROM notifications WHERE recipient_did = 'did:plc:nobodyatallhere000000000'`);
    expect(rows.rows.length).toBe(0);
  });
});
