import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcAuthPost,
  getAdminToken, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { api } from './helpers.js';
import { query } from '../../src/db/client.js';

describe('importRepo', () => {
  let plcAvailable: boolean;
  let adminToken: string;
  let sourceDid: string;
  let exportedCar: Buffer;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    adminToken = await getAdminToken();

    // Create a user with data to export
    const user = await createTestUser(uniqueHandle('import-src'));
    sourceDid = user.did;

    await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
      displayName: 'Import Test User',
      description: 'Testing CAR import',
    });

    // Export as CAR
    const exportRes = await api
      .get(`/xrpc/com.atproto.sync.getRepo?did=${sourceDid}`)
      .buffer(true)
      .parse((res: any, callback: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    exportedCar = exportRes.body;
  });

  it('should reject unauthenticated', async () => {
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo?did=did:plc:test')
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('fake'));
    expect(res.status).toBe(401);
  });

  it('should reject non-admin', async () => {
    if (!plcAvailable) return;
    const user = await createTestUser(uniqueHandle('import-nonadmin'));
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo?did=did:plc:test')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('fake'));
    expect(res.status).toBe(403);
  });

  it('should reject missing did parameter', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('fake'));
    expect(res.status).toBe(400);
  });

  it('should reject if repo already exists', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post(`/xrpc/net.openfederation.admin.importRepo?did=${sourceDid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(exportedCar);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RepoAlreadyExists');
  });

  it('should reject invalid CAR data', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo?did=did:plc:importtest1')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('not valid car data'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidCar');
  });

  it('should reject a CAR whose commit belongs to another DID', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo?did=did:plc:importtest2')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(exportedCar);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('DidMismatch');
  });

  it('should restore an exported repo so its records can be read again', async () => {
    if (!plcAvailable) return;
    // Simulate a fresh server for this DID: drop its repo, then import the backup.
    await query('DELETE FROM records_index WHERE community_did = $1', [sourceDid]);
    await query('DELETE FROM repo_blocks WHERE community_did = $1', [sourceDid]);
    await query('DELETE FROM repo_roots WHERE did = $1', [sourceDid]);

    const res = await api
      .post(`/xrpc/net.openfederation.admin.importRepo?did=${sourceDid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(exportedCar);
    expect(res.status).toBe(200);

    const list = await api.get(`/xrpc/com.atproto.repo.listRecords?repo=${sourceDid}&collection=app.bsky.actor.profile`);
    expect(list.status).toBe(200);
    expect(list.body.records[0].value.displayName).toBe('Import Test User');
  });
});
