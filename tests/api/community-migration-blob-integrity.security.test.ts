/**
 * Blobs pulled from a community's old PDS are stored under a content address.
 * The bytes must actually hash to that address: the old PDS is whatever the
 * DID's owner says it is, so it is not trusted to tell the truth.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { query } from '../../src/db/client.js';
import { getBlobStore } from '../../src/blob/blob-store.js';
import { pullCommunityBlobs } from '../../src/community/migration.js';

async function blobCid(bytes: Uint8Array): Promise<string> {
  return CID.create(1, 0x55, await sha256.digest(bytes)).toString();
}

async function communityReferencing(cid: string): Promise<string> {
  const did = `did:plc:${randomBytes(12).toString('hex')}`;
  await query(
    `INSERT INTO records_index (community_did, collection, rkey, cid, record)
     VALUES ($1, 'net.openfederation.community.profile', 'self', 'bafyplaceholder', $2)`,
    [did, JSON.stringify({ avatar: { $type: 'blob', ref: { $link: cid }, mimeType: 'image/png', size: 4 } })],
  );
  return did;
}

describe('community migration blob integrity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses bytes that do not match the CID, and leaves an existing blob untouched', async () => {
    const victimBytes = Buffer.from('the real avatar');
    const cid = await blobCid(victimBytes);
    const store = await getBlobStore();
    await store.put(cid, victimBytes, 'image/png');
    const did = await communityReferencing(cid);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('attacker bytes'), {
      status: 200, headers: { 'content-type': 'text/html' },
    })));

    await expect(pullCommunityBlobs(did, 'http://localhost:9')).rejects.toThrow(/does not match/i);
    const after = await store.get(cid);
    expect(after?.data.toString()).toBe('the real avatar');
    expect(after?.mimeType).toBe('image/png');
    const owned = await query('SELECT 1 FROM blob_owners WHERE cid = $1 AND did = $2', [cid, did]);
    expect(owned.rows.length).toBe(0);
  });

  it('stores bytes that do match', async () => {
    const bytes = Buffer.from(`honest blob ${randomBytes(4).toString('hex')}`);
    const cid = await blobCid(bytes);
    const did = await communityReferencing(cid);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })));

    const result = await pullCommunityBlobs(did, 'http://localhost:9');
    expect(result).toEqual({ expected: 1, copied: 1 });
    expect((await (await getBlobStore()).get(cid))?.data.equals(bytes)).toBe(true);
  });

  it('refuses a blob larger than the upload limit', async () => {
    const cid = await blobCid(Buffer.from('small'));
    const did = await communityReferencing(cid);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(6 * 1024 * 1024), { status: 200 })));
    await expect(pullCommunityBlobs(did, 'http://localhost:9')).rejects.toThrow(/too large/i);
  });
});

describe('moved keys from the old home', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a junk key bundle is reported as not imported instead of failing the caller', async () => {
    const { fetchMovedKeys } = await import('../../src/community/migration.js');
    const did = `did:plc:${randomBytes(12).toString('hex')}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sealed: 'bm90IGEgcmVhbCBidW5kbGU=' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(fetchMovedKeys(did, 'http://localhost:9')).resolves.toBeNull();
  });
});
