/**
 * A caller proving control of a DID hosted on another PDS is not an account
 * here. It may act where it has standing (a community it owns or belongs to),
 * and not use this server as free storage.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { api, isPLCAvailable } from './helpers.js';
import { userElsewhere, serviceAuthFor } from './migration-helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('remote service-auth callers', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('cannot upload blobs with no standing here', async () => {
    if (!plc) return;
    const remote = await userElsewhere();
    const token = await serviceAuthFor(remote, { lxm: 'com.atproto.repo.uploadBlob' });
    const res = await api.post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${token}`).set('Content-Type', 'image/png').send(PNG);
    expect(res.status).toBe(403);
  });

  it('cannot store custodial secrets', async () => {
    if (!plc) return;
    const remote = await userElsewhere();
    const token = await serviceAuthFor(remote, { lxm: 'net.openfederation.vault.storeCustodialSecret' });
    const res = await api.post('/xrpc/net.openfederation.vault.storeCustodialSecret')
      .set('Authorization', `Bearer ${token}`)
      .send({ secretType: 'mnemonic', chain: 'ethereum', encryptedBlob: 'AAAA', walletAddress: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(403);
  });

  it('cannot create a community (which needs an account here)', async () => {
    if (!plc) return;
    const remote = await userElsewhere();
    const token = await serviceAuthFor(remote, { lxm: 'net.openfederation.community.create' });
    const res = await api.post('/xrpc/net.openfederation.community.create')
      .set('Authorization', `Bearer ${token}`)
      .send({ handle: `remote${Date.now()}`, didMethod: 'plc' });
    expect(res.status).toBe(403);
  });
});
