/**
 * Account migration, blobs (#264): the old PDS lists the blobs a repo
 * references, the new PDS lists the ones it does not hold yet, and the
 * moving account uploads them before it is activated.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { api, xrpcAuthGet, xrpcAuthPost, xrpcGet, isPLCAvailable, createTestUser, uniqueHandle } from './helpers.js';
import { pseudonymElsewhere, openHere, exportedRepo, importRepo } from './migration-helpers.js';

const PROFILE = 'app.bsky.actor.profile';

async function blobCid(bytes: Uint8Array): Promise<string> {
  return CID.create(1, 0x55, await sha256.digest(bytes)).toString();
}

function upload(bytes: Uint8Array, jwt: string) {
  return api.post('/xrpc/com.atproto.repo.uploadBlob')
    .set('Authorization', `Bearer ${jwt}`).set('Content-Type', 'image/png').send(Buffer.from(bytes));
}

describe('blobs in account migration', () => {
  let plc = false;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('lists the imported records\' blobs as missing until the moving account uploads them', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    const avatar = new TextEncoder().encode(`avatar ${p.did}`);
    const banner = new TextEncoder().encode(`banner ${p.did}`);
    const [avatarCid, bannerCid] = [await blobCid(avatar), await blobCid(banner)];
    const ref = (cid: string, size: number) => ({ $type: 'blob', ref: CID.parse(cid), mimeType: 'image/png', size });
    expect((await importRepo(await exportedRepo(p.did, p.oldKey, [
      { collection: PROFILE, rkey: 'self', record: { $type: PROFILE, avatar: ref(avatarCid, avatar.length), banner: ref(bannerCid, banner.length) } },
      { collection: 'net.openfederation.authorship.claim', rkey: '3kclaim0001', record: {
        $type: 'net.openfederation.authorship.claim', contentHash: 'aa'.repeat(32), url: 'https://news.example/x',
        createdAt: new Date().toISOString(), image: ref(avatarCid, avatar.length),
      } },
    ]), accessJwt)).status).toBe(200);

    const missing = await xrpcAuthGet('com.atproto.repo.listMissingBlobs', accessJwt);
    expect(missing.status).toBe(200);
    expect(missing.body.blobs.map((b: { cid: string }) => b.cid).sort()).toEqual([avatarCid, bannerCid].sort());
    expect(missing.body.blobs.find((b: { cid: string }) => b.cid === bannerCid).recordUri).toBe(`at://${p.did}/${PROFILE}/self`);

    const before = await xrpcAuthGet('com.atproto.server.checkAccountStatus', accessJwt);
    expect(before.body).toMatchObject({ expectedBlobs: 2, importedBlobs: 0 });

    // The account is still deactivated, and uploading is allowed.
    const up = await upload(avatar, accessJwt);
    expect(up.status).toBe(200);
    expect(up.body.blob.ref.$link).toBe(avatarCid);
    const page = await xrpcAuthGet('com.atproto.repo.listMissingBlobs', accessJwt, { limit: '1' });
    expect(page.body).toEqual({ blobs: [{ cid: bannerCid, recordUri: `at://${p.did}/${PROFILE}/self` }], cursor: bannerCid });
    expect((await upload(banner, accessJwt)).status).toBe(200);

    expect((await xrpcAuthGet('com.atproto.repo.listMissingBlobs', accessJwt)).body).toEqual({ blobs: [] });
    const after = await xrpcAuthGet('com.atproto.server.checkAccountStatus', accessJwt);
    expect(after.body).toMatchObject({ expectedBlobs: 2, importedBlobs: 2 });

    const listed = await xrpcGet('com.atproto.sync.listBlobs', { did: p.did });
    expect(listed.body.cids).toEqual([avatarCid, bannerCid].sort());
  });

  it('lists the blobs a local account\'s records reference, paginated in CID order', async () => {
    const user = await createTestUser(uniqueHandle('blobs'));
    const cids: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await upload(new TextEncoder().encode(`img ${user.did} ${n}`), user.accessJwt);
      expect(res.status).toBe(200);
      cids.push(res.body.blob.ref.$link);
      expect((await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
        repo: user.did, collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: `post ${n}`, createdAt: new Date().toISOString(),
          embed: { $type: 'app.bsky.embed.images', images: [{ alt: '', image: res.body.blob }] } },
      })).status).toBe(200);
    }
    // An uploaded blob no record references is not listed.
    expect((await upload(new TextEncoder().encode(`orphan ${user.did}`), user.accessJwt)).status).toBe(200);

    const first = await xrpcGet('com.atproto.sync.listBlobs', { did: user.did, limit: '2' });
    expect(first.status).toBe(200);
    expect(first.body.cids).toHaveLength(2);
    const rest = await xrpcGet('com.atproto.sync.listBlobs', { did: user.did, cursor: first.body.cursor });
    expect([...first.body.cids, ...rest.body.cids]).toEqual([...cids].sort());
    expect(rest.body.cursor).toBeUndefined();

    // A local account holds all its blobs.
    expect((await xrpcAuthGet('com.atproto.repo.listMissingBlobs', user.accessJwt)).body).toEqual({ blobs: [] });
  });

  it('listBlobs needs a known repo; listMissingBlobs needs a session', async () => {
    expect((await xrpcGet('com.atproto.sync.listBlobs', { did: 'did:plc:nosuchrepoaaaaaaaaaaaaaa' })).status).toBe(404);
    expect((await xrpcGet('com.atproto.sync.listBlobs', {})).status).toBe(400);
    expect((await xrpcGet('com.atproto.repo.listMissingBlobs')).status).toBe(401);
  });
});
