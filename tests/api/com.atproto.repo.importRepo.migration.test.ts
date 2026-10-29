/**
 * Account migration, second step (#262): the owner of an account moving
 * here imports the repository exported by the old PDS. The CAR is verified
 * against the DID's current atproto key before anything is stored.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { readCarWithRoot, blocksToCarFile, BlockMap } from '@atproto/repo';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { api, xrpcAuthGet, xrpcGet, isPLCAvailable, createTestUser, uniqueHandle } from './helpers.js';
import { query, withTransaction } from '../../src/db/client.js';
import { storeRepoImport } from '../../src/repo/import.js';
import { pseudonymElsewhere, openHere, exportedRepo, importRepo, type RecordWrite } from './migration-helpers.js';

const PROFILE = 'app.bsky.actor.profile';
const CLAIM = 'net.openfederation.authorship.claim';

async function blobCid(text: string): Promise<CID> {
  return CID.create(1, 0x55, await sha256.digest(new TextEncoder().encode(text)));
}

async function writes(): Promise<RecordWrite[]> {
  const avatar = await blobCid('avatar bytes');
  return [
    {
      collection: PROFILE, rkey: 'self',
      record: {
        $type: PROFILE, displayName: 'Night Desk',
        avatar: { $type: 'blob', ref: avatar, mimeType: 'image/png', size: 12 },
      },
    },
    ...[1, 2, 3].map((n) => ({
      collection: CLAIM, rkey: `3kclaim000${n}`,
      record: { $type: CLAIM, contentHash: `${n}`.repeat(64), url: `https://news.example/${n}`, createdAt: new Date().toISOString() },
    })),
  ];
}

async function placeholderRoot(did: string): Promise<string> {
  return (await query<{ root_cid: string }>('SELECT root_cid FROM repo_roots WHERE did = $1', [did])).rows[0].root_cid;
}

describe('com.atproto.repo.importRepo (account migration)', () => {
  let plc = false;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('imports the verified repository and serves its records', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    const car = await exportedRepo(p.did, p.oldKey, await writes());

    const res = await importRepo(car, accessJwt);
    expect(res.status).toBe(200);

    const { root } = await readCarWithRoot(car);
    const status = await xrpcAuthGet('com.atproto.server.checkAccountStatus', accessJwt);
    expect(status.body).toMatchObject({ activated: false, repoCommit: root.toString(), indexedRecords: 4 });

    const claims = await xrpcGet('com.atproto.repo.listRecords', { repo: p.did, collection: CLAIM });
    expect(claims.body.records).toHaveLength(3);

    // Blob references come back in AT Protocol JSON form.
    const profile = await xrpcGet('com.atproto.repo.getRecord', { repo: p.did, collection: PROFILE, rkey: 'self' });
    expect(profile.body.value.avatar).toEqual({
      $type: 'blob', ref: { $link: (await blobCid('avatar bytes')).toString() }, mimeType: 'image/png', size: 12,
    });
  });

  it('can be repeated: a second import replaces the first', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    expect((await importRepo(await exportedRepo(p.did, p.oldKey, await writes()), accessJwt)).status).toBe(200);
    const smaller = (await writes()).slice(0, 2);
    expect((await importRepo(await exportedRepo(p.did, p.oldKey, smaller), accessJwt)).status).toBe(200);
    const count = await query('SELECT 1 FROM records_index WHERE community_did = $1', [p.did]);
    expect(count.rows).toHaveLength(2);
  });

  it('refuses a repository not signed by the DID\'s atproto key, and stores nothing', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    const before = await placeholderRoot(p.did);
    const forged = await exportedRepo(p.did, await Secp256k1Keypair.create(), await writes());

    const res = await importRepo(forged, accessJwt);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidSignature');
    expect(await placeholderRoot(p.did)).toBe(before);
    expect((await query('SELECT 1 FROM records_index WHERE community_did = $1', [p.did])).rows).toHaveLength(0);
  });

  it('refuses a repository with a missing record block', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    const car = await exportedRepo(p.did, p.oldKey, await writes());
    const { root, blocks } = await readCarWithRoot(car);

    // Drop one record block: the tree points at it, so verification fails.
    const trimmed = new BlockMap();
    let dropped = false;
    blocks.forEach((bytes, cid) => {
      if (!dropped && !cid.equals(root) && bytes.length > 0 && new TextDecoder().decode(bytes).includes('news.example/2')) {
        dropped = true;
        return;
      }
      trimmed.set(cid, bytes);
    });
    expect(dropped).toBe(true);

    const res = await importRepo(await blocksToCarFile(root, trimmed), accessJwt);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRepo');
  });

  it('refuses another DID\'s repository', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const other = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    const res = await importRepo(await exportedRepo(other.did, other.oldKey, await writes()), accessJwt);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('DidMismatch');
  });

  it('is only for an account that is moving here and not yet activated', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const user = await createTestUser(uniqueHandle('imp-local'));
    const res = await importRepo(new Uint8Array([1, 2, 3]), user.accessJwt);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');

    const anon = await api.post('/xrpc/com.atproto.repo.importRepo').set('Content-Type', 'application/vnd.ipld.car').send(Buffer.from([1]));
    expect(anon.status).toBe(401);
  });

  it('writes everything in one transaction: a failure part-way leaves no rows behind', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    await openHere(p);
    const before = await placeholderRoot(p.did);
    const blocksBefore = (await query('SELECT 1 FROM repo_blocks WHERE community_did = $1', [p.did])).rows.length;

    // A record whose collection is longer than the column allows fails after
    // the blocks and root were written.
    await expect(withTransaction((client) => storeRepoImport(client, p.did, {
      root: 'bafyreigarbageroot', rev: '3kzzzzzzzzzzz',
      blocks: [{ cid: 'bafyreigarbageblock', bytes: new Uint8Array([1]) }],
      records: [{ collection: 'x'.repeat(300), rkey: 'self', cid: 'bafyreigarbagerecord', record: {} }],
    }, { replace: true }))).rejects.toThrow();

    expect(await placeholderRoot(p.did)).toBe(before);
    expect((await query('SELECT 1 FROM repo_blocks WHERE community_did = $1', [p.did])).rows.length).toBe(blocksBefore);
  });
});
