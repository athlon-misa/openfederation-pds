/**
 * Repo monitoring against this PDS (#241): the SDK watcher reads the public
 * com.atproto.sync endpoints, sees the device's own writes as expected, and
 * reports a record the operator wrote with the repo key the PDS holds. The
 * evidence holds up: the commit verifies with the DID's `atproto` key (the
 * PDS's), and the record carries no owner signature.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { config } from '../../src/config.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { xrpcAuthPost, isPLCAvailable, createTestUser, uniqueHandle } from './helpers.js';
import {
  RepoWatcher, verifyRepoCommit, verifyOwnerRecord, readRepoCar, deriveCustodyKeys, generateCustodyPhrase,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const POST = 'app.bsky.feed.post';
const PLC = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';

describe('RepoWatcher against this PDS', () => {
  let plc = false;
  let user: { accessJwt: string; did: string };
  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (plc) user = await createTestUser(uniqueHandle('watch'));
  });

  it('stays clean for the device\'s writes and reports one the operator made', async () => {
    if (!plc) return;
    const client = {
      fetch: async (nsid: string, opts: { body: Record<string, unknown> }) => {
        const res = await xrpcAuthPost(nsid, user.accessJwt, opts.body);
        if (res.status !== 200) throw new Error(`${nsid}: ${res.status} ${JSON.stringify(res.body)}`);
        return res.body;
      },
    };
    const watcher = new RepoWatcher({ source: config.pds.serviceUrl });
    expect((await watcher.check(user.did)).status).toBe('baseline');

    await watcher.write(client, 'com.atproto.repo.createRecord', {
      repo: user.did, collection: POST, record: { $type: POST, text: 'filed from my laptop', createdAt: new Date().toISOString() },
    });
    await watcher.write(client, 'com.atproto.repo.putRecord', {
      repo: user.did, collection: POST, rkey: '3kmine0000001', record: { $type: POST, text: 'mine', createdAt: new Date().toISOString() },
    });
    expect((await watcher.check(user.did)).status).toBe('clean');

    // The operator writes with the repo key the PDS holds.
    const forgedRecord = { $type: POST, text: 'I retract my story', createdAt: new Date().toISOString() };
    await new RepoEngine(user.did).putRecord(await getKeypairForDid(user.did), POST, '3kforged00001', forgedRecord);

    const result = await watcher.check(user.did);
    expect(result.status).toBe('unknown-changes');
    const [u] = result.unknownCommits;
    expect(u.changes).toEqual([expect.objectContaining({ rkey: '3kforged00001', action: 'create', expectedCid: null })]);
    expect(readRepoCar(result.car!).commit.cid).toBe(u.cid);

    // Attributable: the DID's atproto key (the PDS's) signed the commit ...
    const doc = await (await fetch(`${PLC}/${user.did}/data`)).json() as { verificationMethods: { atproto: string } };
    expect(verifyRepoCommit(u.commit, doc.verificationMethods.atproto)).toBe(true);
    // ... and no owner key signed the record.
    const someOwner = deriveCustodyKeys(generateCustodyPhrase()).ownerDidKey;
    expect(verifyOwnerRecord(forgedRecord, { did: user.did, collection: POST, ownerDidKey: someOwner })).toEqual({ ok: false, reason: 'NotSigned' });
  });
});
