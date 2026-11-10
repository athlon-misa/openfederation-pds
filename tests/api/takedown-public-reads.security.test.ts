/**
 * A taken-down account is not served to anyone but a PDS admin: not its
 * repository, and not its blobs, profile, external keys or wallets either.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, xrpcGet, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('takedown covers public reads', () => {
  let plc = false;
  let user: { did: string; accessJwt: string };
  let cid: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    user = await createTestUser(uniqueHandle('tdreads'));
    const up = await api.post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`).set('Content-Type', 'image/png').send(PNG);
    expect(up.status).toBe(200);
    cid = up.body.blob.ref.$link;
    await query(`UPDATE users SET status = 'takendown' WHERE did = $1`, [user.did]);
  });

  afterAll(async () => {
    if (user) await query(`UPDATE users SET status = 'approved' WHERE did = $1`, [user.did]);
  });

  const reads: Array<[string, () => Promise<{ status: number; body: any }>]> = [
    ['sync.getBlob', () => xrpcGet('com.atproto.sync.getBlob', { did: user.did, cid })],
    ['/blob route', () => api.get(`/blob/${user.did}/${cid}`)],
    ['account.getProfile', () => xrpcGet('net.openfederation.account.getProfile', { did: user.did })],
    ['identity.listExternalKeys', () => xrpcGet('net.openfederation.identity.listExternalKeys', { did: user.did })],
    ['identity.getExternalKey', () => xrpcGet('net.openfederation.identity.getExternalKey', { did: user.did, rkey: 'x' })],
    ['identity.listWalletsPublic', () => xrpcGet('net.openfederation.identity.listWalletsPublic', { did: user.did })],
    ['identity.getPrimaryWallet', () => xrpcGet('net.openfederation.identity.getPrimaryWallet', { did: user.did, chain: 'ethereum' })],
    ['identity.getDidAugmentation', () => xrpcGet('net.openfederation.identity.getDidAugmentation', { did: user.did })],
  ];

  for (const [name, call] of reads) {
    it(`${name} refuses a taken-down account`, async () => {
      if (!plc) return;
      const res = await call();
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toBe('RepoTakendown');
    });
  }

  it('a PDS admin can still fetch the blob', async () => {
    if (!plc) return;
    const res = await api.get('/xrpc/com.atproto.sync.getBlob').query({ did: user.did, cid })
      .set('Authorization', `Bearer ${await getAdminToken()}`);
    expect(res.status).toBe(200);
  });
});
