/**
 * The blob read path and profile wiring that complete #82.
 *
 * `uploadBlob` existed; what was missing was the ATProto-standard way to get
 * the bytes back (`com.atproto.sync.getBlob`) and a way to put the uploaded
 * blob onto a profile. The contract under test: upload → reference from the
 * profile → fetch by (did, cid), with the (did, cid) binding enforced — a
 * blob is fetched from the repo that references it, not from a global
 * content store — and profiles only referencing blobs their own DID owns.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  api, xrpcAuthPost, xrpcGet,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

type User = { accessJwt: string; did: string; handle: string };

/** A tiny valid PNG (1x1 transparent pixel). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(user: User, bytes: Buffer): Promise<{ $type: string; ref: { $link: string }; mimeType: string; size: number }> {
  const res = await api.post('/xrpc/com.atproto.repo.uploadBlob')
    .set('Authorization', `Bearer ${user.accessJwt}`)
    .set('Content-Type', 'image/png')
    .send(bytes);
  expect(res.status).toBe(200);
  return res.body.blob;
}

describe('com.atproto.sync.getBlob + profile avatars (#82)', () => {
  let plcAvailable: boolean;
  let alice: User;
  let bob: User;
  let blob: Awaited<ReturnType<typeof upload>>;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    alice = await createTestUser(uniqueHandle('blob-alice'));
    bob = await createTestUser(uniqueHandle('blob-bob'));
    blob = await upload(alice, PNG);
  });

  it('returns the exact bytes, content type, and immutable caching', async () => {
    if (!plcAvailable) return;
    const res = await api.get(`/xrpc/com.atproto.sync.getBlob?did=${alice.did}&cid=${blob.ref.$link}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
  });

  it('binds the blob to its owning DID — another DID cannot serve it', async () => {
    if (!plcAvailable) return;
    // Bob never uploaded this blob; fetching it "from" his repo must fail,
    // or the endpoint degrades into a global content store keyed by hash.
    const res = await api.get(`/xrpc/com.atproto.sync.getBlob?did=${bob.did}&cid=${blob.ref.$link}`);
    expect(res.status).toBe(404);
  });

  it('404s an unknown CID and a non-canonical one alike', async () => {
    if (!plcAvailable) return;
    const unknown = await api.get(`/xrpc/com.atproto.sync.getBlob?did=${alice.did}&cid=bafkreidoesnotexistaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    expect(unknown.status).toBe(404);
    const garbage = await api.get(`/xrpc/com.atproto.sync.getBlob?did=${alice.did}&cid=not-a-cid`);
    expect(garbage.status).toBe(404);
  });

  it('puts the uploaded blob on the profile, exactly as uploadBlob returned it', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.account.updateProfile', alice.accessJwt, {
      displayName: 'Alice', avatar: blob,
    });
    expect(res.status).toBe(200);

    const record = await xrpcGet('com.atproto.repo.getRecord', {
      repo: alice.did, collection: 'app.bsky.actor.profile', rkey: 'self',
    });
    expect(record.status).toBe(200);
    expect(record.body.value.avatar).toEqual(blob);
    // ...and the reference resolves: profile → CID → bytes.
    const bytes = await api.get(`/xrpc/com.atproto.sync.getBlob?did=${alice.did}&cid=${record.body.value.avatar.ref.$link}`);
    expect(bytes.status).toBe(200);
  });

  it("refuses a profile referencing someone else's blob", async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.account.updateProfile', bob.accessJwt, {
      avatar: blob, // alice's upload
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidBlobRef');
  });

  it('refuses a malformed blob ref', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.account.updateProfile', alice.accessJwt, {
      avatar: { $type: 'blob', ref: { $link: 12345 } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidBlobRef');
  });

  it('removes the avatar with null, leaving the rest of the profile alone', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.account.updateProfile', alice.accessJwt, {
      avatar: null,
    });
    expect(res.status).toBe(200);

    const record = await xrpcGet('com.atproto.repo.getRecord', {
      repo: alice.did, collection: 'app.bsky.actor.profile', rkey: 'self',
    });
    expect(record.body.value.avatar).toBeUndefined();
    expect(record.body.value.displayName).toBe('Alice');
  });
});
