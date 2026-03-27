import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { api } from './helpers.js';

describe('uploadBlob', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('blob'));
  });

  it('should reject unauthenticated upload', async () => {
    const res = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(res.status).toBe(401);
  });

  it('should reject disallowed MIME type', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('fake pdf'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidMimeType');
  });

  it('should upload a blob and return a blob ref', async () => {
    if (!plcAvailable) return;
    const fakeImage = Buffer.alloc(256, 0xff);
    const res = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'image/jpeg')
      .send(fakeImage);
    expect(res.status).toBe(200);
    expect(res.body.blob).toBeTruthy();
    expect(res.body.blob.$type).toBe('blob');
    expect(res.body.blob.ref.$link).toBeTruthy();
    expect(res.body.blob.mimeType).toBe('image/jpeg');
    expect(res.body.blob.size).toBe(256);
  });

  it('should serve an uploaded blob', async () => {
    if (!plcAvailable) return;
    const fakeImage = Buffer.alloc(128, 0xaa);
    const uploadRes = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'image/png')
      .send(fakeImage);
    expect(uploadRes.status).toBe(200);

    const cid = uploadRes.body.blob.ref.$link;
    const serveRes = await api.get(`/blob/${user.did}/${cid}`);
    expect(serveRes.status).toBe(200);
    expect(serveRes.headers['content-type']).toContain('image/png');
    expect(serveRes.headers['cache-control']).toContain('immutable');
  });

  it('should return 404 for non-existent blob', async () => {
    const res = await api.get('/blob/did:plc:test/bafkreinonexistent');
    expect(res.status).toBe(404);
  });
});
