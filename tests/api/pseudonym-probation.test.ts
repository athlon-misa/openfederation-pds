import { describe, it, expect, afterEach } from 'vitest';
import { xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { insertPseudonymUser } from './pseudonym-helpers.js';
import { issueSessionForTests } from './pseudonym-session-for-tests.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';
import { resetProbationForTests } from '../../src/auth/pseudonym-probation.js';

const original = { ...config.pseudonym };
afterEach(() => { Object.assign(config.pseudonym, original); resetProbationForTests(); });

async function write(jwt: string, did: string) {
  return xrpcAuthPost('com.atproto.repo.createRecord', jwt, {
    repo: did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'x', createdAt: new Date().toISOString() },
  });
}

describe('pseudonym probation', () => {
  it('caps daily writes for a new pseudonym when enabled', async () => {
    Object.assign(config.pseudonym, { probationDays: 7, probationDailyWrites: 2 });
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    expect((await write(accessJwt, p.did)).status).not.toBe(429);
    expect((await write(accessJwt, p.did)).status).not.toBe(429);
    const third = await write(accessJwt, p.did);
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('ProbationLimit');
  });

  it('does nothing when disabled or after the probation period', async () => {
    Object.assign(config.pseudonym, { probationDays: 0, probationDailyWrites: 1 });
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    for (let i = 0; i < 3; i++) expect((await write(accessJwt, p.did)).status).not.toBe(429);

    Object.assign(config.pseudonym, { probationDays: 7, probationDailyWrites: 1 });
    const old = await insertPseudonymUser();
    await query(`UPDATE users SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [old.id]);
    const s = await issueSessionForTests(old);
    for (let i = 0; i < 3; i++) expect((await write(s.accessJwt, old.did)).status).not.toBe(429);
  });

  it('does not consume quota for a malformed createRecord', async () => {
    Object.assign(config.pseudonym, { probationDays: 7, probationDailyWrites: 1 });
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    const bad = await xrpcAuthPost('com.atproto.repo.createRecord', accessJwt, { repo: p.did });
    expect(bad.status).toBe(400);
    expect((await write(accessJwt, p.did)).status).not.toBe(429);
    expect((await write(accessJwt, p.did)).status).toBe(429);
  });

  it('caps forum.createThread for a new pseudonym member (permission checked first)', async () => {
    if (!(await isPLCAvailable())) return;
    Object.assign(config.pseudonym, { probationDays: 7, probationDailyWrites: 1 });
    const owner = await createTestUser(uniqueHandle('pb-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('pb-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(create.status).toBe(201);
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    const body = { community: create.body.did, title: 'hello' };

    // Non-member is denied by permission check without consuming quota.
    const denied = await xrpcAuthPost('net.openfederation.forum.createThread', accessJwt, body);
    expect(denied.status).toBe(403);

    expect((await xrpcAuthPost('net.openfederation.community.join', accessJwt, { did: create.body.did })).status).toBe(200);
    // pseudonym has no repo, so the first write may fail, but it must not be a 429
    expect((await xrpcAuthPost('net.openfederation.forum.createThread', accessJwt, body)).status).not.toBe(429);
    const over = await xrpcAuthPost('net.openfederation.forum.createThread', accessJwt, body);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('ProbationLimit');
  });
});
