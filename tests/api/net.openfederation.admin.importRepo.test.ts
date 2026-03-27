import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcAuthPost,
  getAdminToken, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { api } from './helpers.js';

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
});
