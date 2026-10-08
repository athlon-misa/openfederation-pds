import { describe, it, expect, afterEach } from 'vitest';
import { xrpcAuthPost } from './helpers.js';
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
});
