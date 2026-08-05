import { describe, expect, it } from 'vitest';
import {
  createTestUser,
  uniqueHandle,
  xrpcAuthPost,
  xrpcGet,
} from './helpers.js';

describe('com.atproto.repo.listRecords pagination', () => {
  it('paginates reverse pages in one descending global rkey order', async () => {
    const user = await createTestUser(uniqueHandle('list-page'));
    const collection = 'com.example.note';
    const rkeys = ['0004', '0003', '0002', '0001'];

    for (const rkey of rkeys) {
      const created = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
        repo: user.did,
        collection,
        rkey,
        record: { text: rkey, createdAt: new Date().toISOString() },
      });
      expect(created.status).toBe(200);
    }

    const first = await xrpcGet('com.atproto.repo.listRecords', {
      repo: user.did, collection, limit: '2', reverse: 'true',
    });
    const second = await xrpcGet('com.atproto.repo.listRecords', {
      repo: user.did, collection, limit: '2', reverse: 'true', cursor: first.body.cursor,
    });

    expect(first.status).toBe(200);
    expect(first.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0004', '0003']);
    expect(second.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0002', '0001']);
    expect(second.body.cursor).toBeUndefined();
  });

  it('paginates forward pages in one ascending global rkey order', async () => {
    const user = await createTestUser(uniqueHandle('list-page'));
    const collection = 'com.example.note';
    for (const rkey of ['0004', '0003', '0002', '0001']) {
      const created = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
        repo: user.did,
        collection,
        rkey,
        record: { text: rkey, createdAt: new Date().toISOString() },
      });
      expect(created.status).toBe(200);
    }

    const first = await xrpcGet('com.atproto.repo.listRecords', {
      repo: user.did, collection, limit: '2',
    });
    const second = await xrpcGet('com.atproto.repo.listRecords', {
      repo: user.did, collection, limit: '2', cursor: first.body.cursor,
    });

    expect(first.status).toBe(200);
    expect(first.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0001', '0002']);
    expect(second.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0003', '0004']);
    expect(second.body.cursor).toBeUndefined();
  });
});
